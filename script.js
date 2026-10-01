/*
==========================================================
OUR LITTLE WORLD — REMOTE PHOTO BOOTH

1. Put your Supabase URL and anon/publishable key below.
2. Supabase Auth handles accounts.
3. Supabase Realtime handles room presence + WebRTC signaling.
4. WebRTC carries the actual camera video.

IMPORTANT:
Supabase is NOT carrying the video itself.
The browser-to-browser WebRTC connection carries video.
==========================================================
*/

(function () {

const SUPABASE_URL = "https://keymklolnvpfgwsszmgr.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_5OGo8DdSvOAcomEPNCCsSw_g0owElw4";

const supabase = window.supabase.createClient(
  SUPABASE_URL,
  SUPABASE_ANON_KEY
);


/*
  WebRTC ICE servers.

  STUN is always used. TURN (relay) credentials are NOT stored
  in this public file: they are short-lived credentials fetched
  from the Supabase Edge Function below, which holds the TURN
  provider's secret server-side
  (see supabase/functions/turn-credentials/index.ts).

  If the function is missing or fails, WebRTC falls back to
  STUN only. Set to "" to disable TURN entirely.
*/
const STUN_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" }
];

const TURN_CREDENTIALS_FUNCTION = "turn-credentials";

// Re-fetch TURN credentials after this long (they expire server-side).
const TURN_CACHE_MS = 60 * 60 * 1000;


// ---------- DOM ----------

const authCard = document.getElementById("authCard");
const roomCard = document.getElementById("roomCard");
const videoCard = document.getElementById("videoCard");
const memoriesCard = document.getElementById("memoriesCard");

const emailInput = document.getElementById("email");
const passwordInput = document.getElementById("password");

const signupBtn = document.getElementById("signupBtn");
const loginBtn = document.getElementById("loginBtn");
const logoutBtn = document.getElementById("logoutBtn");

const authStatus = document.getElementById("authStatus");
const roomStatus = document.getElementById("roomStatus");
const userLabel = document.getElementById("userLabel");

const roomCodeInput = document.getElementById("roomCode");
const createRoomBtn = document.getElementById("createRoomBtn");
const joinRoomBtn = document.getElementById("joinRoomBtn");
const leaveRoomBtn = document.getElementById("leaveRoomBtn");

const localVideo = document.getElementById("localVideo");
const remoteVideo = document.getElementById("remoteVideo");
const remotePlaceholder = document.getElementById("remotePlaceholder");
const localRoleLabel = document.getElementById("localRoleLabel");
const remoteRoleLabel = document.getElementById("remoteRoleLabel");

const cameraBtn = document.getElementById("cameraBtn");
const captureBtn = document.getElementById("captureBtn");
const downloadBtn = document.getElementById("downloadBtn");

const connectionStatus = document.getElementById("connectionStatus");
const photoStatus = document.getElementById("photoStatus");

const canvas = document.getElementById("canvas");
const countdownOverlay = document.getElementById("countdownOverlay");
const countdownNumber = document.getElementById("countdownNumber");
const flash = document.getElementById("flash");

const gallery = document.getElementById("gallery");


// ---------- STATE ----------

let currentUser = null;
let currentRoom = null;
let channel = null;

// Explicit role, set by the action used to enter the room.
// "Koko" = creator (always makes the initial WebRTC offer).
// "BaoBao" = joiner (never makes the initial offer).
let myRole = null;

let localStream = null;
let peerConnection = null;
let peerConnectionStarting = null;

let turnServers = null;
let turnServersFetchedAt = 0;

let remoteUserId = null;
let makingOffer = false;

let pendingCandidates = [];

let latestPhoto = null;

// Shared memories for the current room, newest first.
// Each entry is a public.memories row plus a displayable `url`.
let memories = [];

// The running synchronized countdown, if any:
// { captureId, initiatorId, timers }
let activeCapture = null;


// ---------- UI ----------

function show(element) {
  element.classList.remove("hidden");
}

function hide(element) {
  element.classList.add("hidden");
}

function setAuthStatus(message) {
  authStatus.textContent = message;
}

function setRoomStatus(message) {
  roomStatus.textContent = message;
}

function setConnectionStatus(message) {
  connectionStatus.textContent = message;
}

function setPhotoStatus(message) {
  photoStatus.textContent = message;
}


function remoteRoleName() {
  if (myRole === "Koko") return "BaoBao";
  if (myRole === "BaoBao") return "Koko";
  return "your person";
}


// Reflects the local role (never the remote user's role) in the UI.
function updateRoleUI() {

  if (localRoleLabel) {
    localRoleLabel.textContent = myRole
      ? `${myRole} ♡ (You)`
      : "You";
  }

  if (remoteRoleLabel) {
    remoteRoleLabel.textContent = myRole
      ? `${remoteRoleName()} ♡`
      : "Your person";
  }

  if (remotePlaceholder && !remoteUserId) {
    remotePlaceholder.textContent =
      `Waiting for ${remoteRoleName()}...`;
  }

  if (userLabel && currentUser) {
    userLabel.textContent = myRole
      ? `Logged in as ${currentUser.email} · ${myRole} ♡`
      : `Logged in as ${currentUser.email}`;
  }
}


// ---------- AUTH ----------

async function signUp() {
  const email = emailInput.value.trim();
  const password = passwordInput.value;

  if (!email || !password) {
    setAuthStatus("Enter your email and password.");
    return;
  }

  if (password.length < 6) {
    setAuthStatus("Password should be at least 6 characters.");
    return;
  }

  setAuthStatus("Creating your account...");

  const { data, error } = await supabase.auth.signUp({
    email,
    password
  });

  if (error) {
    setAuthStatus(error.message);
    return;
  }

  if (data.session) {
    setAuthStatus("Account created ♡");
    await handleSignedIn(data.session.user);
  } else {
    setAuthStatus(
      "Account created. Check your email to confirm your account, then log in."
    );
  }
}


async function login() {
  const email = emailInput.value.trim();
  const password = passwordInput.value;

  if (!email || !password) {
    setAuthStatus("Enter your email and password.");
    return;
  }

  setAuthStatus("Logging in...");

  const { data, error } =
    await supabase.auth.signInWithPassword({
      email,
      password
    });

  if (error) {
    setAuthStatus(error.message);
    return;
  }

  await handleSignedIn(data.user);
}


async function logout() {
  await leaveRoom();

  const { error } =
    await supabase.auth.signOut();

  if (error) {
    console.error(error);
  }

  await handleSignedOut();

  setAuthStatus("Logged out ♡");
}


// Resets the UI to the logged-out state. Used for an explicit
// logout and for an expired/invalid session (SIGNED_OUT event),
// so a stale session never leaves buttons silently broken.
async function handleSignedOut() {
  await leaveRoom();

  currentUser = null;

  hide(roomCard);
  hide(videoCard);
  hide(memoriesCard);
  show(authCard);
}


async function handleSignedIn(user) {
  currentUser = user;

  userLabel.textContent =
    `Logged in as ${user.email}`;

  hide(authCard);
  show(roomCard);
  show(memoriesCard);

  setAuthStatus("");
}


// Check an existing login when page opens.
async function checkSession() {
  const {
    data: { session }
  } = await supabase.auth.getSession();

  if (session?.user) {
    await handleSignedIn(session.user);
  }
}


// Listen for login/logout changes.
supabase.auth.onAuthStateChange(
  async (event, session) => {

    if (event === "SIGNED_IN" && session?.user) {
      await handleSignedIn(session.user);
    }

    if (event === "SIGNED_OUT") {
      await handleSignedOut();
    }
  }
);


// ---------- ROOM ----------

function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  let code = "";

  for (let i = 0; i < 6; i++) {
    code += chars[
      Math.floor(Math.random() * chars.length)
    ];
  }

  return code;
}


async function createRoom() {
  if (!currentUser) return;

  const code = generateRoomCode();

  roomCodeInput.value = code;

  myRole = "Koko";
  console.log("[ROLE] Local role: Koko (creator)");
  updateRoleUI();

  await enterRoom(code);
}


async function joinRoom() {
  if (!currentUser) return;

  const code =
    roomCodeInput.value
      .trim()
      .toUpperCase();

  if (!/^[A-Z0-9]{6}$/.test(code)) {
    setRoomStatus("Enter the 6-character room code.");
    return;
  }

  myRole = "BaoBao";
  console.log("[ROLE] Local role: BaoBao (joiner)");
  updateRoleUI();

  await enterRoom(code);
}


// Only Koko (the creator) is ever allowed to create the initial
// WebRTC offer. BaoBao (the joiner) always waits for it. This is
// checked here rather than by device/browser detection so the
// role is deterministic regardless of presence-event timing.
async function maybeCreateOffer() {

  if (myRole !== "Koko") {
    console.log(
      "[WEBRTC] Local role is",
      myRole,
      "- waiting for the offer, not creating one."
    );
    return;
  }

  if (!remoteUserId) {
    return;
  }

  await makeOffer();
}


async function enterRoom(code) {

  await leaveRoom({ keepRole: true });

  currentRoom = code;

  roomCodeInput.value = code;

  setRoomStatus(
    `Connecting to room ${code}...`
  );

  // Runs alongside the Realtime/WebRTC setup, never blocking it.
  prepareMemories(code);

  show(videoCard);

  channel = supabase.channel(
    `koko-baobao-room-${code}`,
    {
      config: {
        presence: {
          key: currentUser.id
        },
        broadcast: {
          self: false
        }
      }
    }
  );


  channel
    .on(
      "presence",
      {
        event: "sync"
      },
      async () => {

        const state =
          channel.presenceState();

        const people =
          Object.keys(state);

        const others =
          people.filter(
            id => id !== currentUser.id
          );

        if (others.length > 0) {

          // Keep the existing remote peer if they're still
          // present; only pick a new one if we don't have one.
          // The room supports two people, so a stray extra
          // presence entry should never bump the active peer.
          if (!remoteUserId || !others.includes(remoteUserId)) {
            remoteUserId = others[0];
          }

          console.log("[ROOM] Remote user detected:", remoteUserId);

          setRoomStatus(
            "Your person is here ♡"
          );

          setConnectionStatus(
            "Connecting your cameras..."
          );

          await startPeerConnection();

          await maybeCreateOffer();

        } else {

          remoteUserId = null;

          setRoomStatus(
            `Room ${code} is ready. Send the code to your person ♡`
          );

          setConnectionStatus(
            `Waiting for ${remoteRoleName()}...`
          );

          updateRoleUI();
        }
      }
    )
    .on(
      "presence",
      {
        event: "join"
      },
      async ({ key }) => {

        if (key === currentUser.id) {
          return;
        }

        if (remoteUserId && remoteUserId !== key) {
          console.log(
            "[ROOM] Ignoring extra participant, room already full:",
            key
          );
          return;
        }

        remoteUserId = key;

        console.log("[ROOM] Remote user joined:", key);

        setRoomStatus(
          "Your person joined ♡"
        );

        setConnectionStatus(
          "Connecting your cameras..."
        );

        await startPeerConnection();

        // Only Koko (the creator) creates the initial offer.
        // BaoBao waits for it. See maybeCreateOffer().
        await maybeCreateOffer();
      }
    )
    .on(
      "presence",
      {
        event: "leave"
      },
      ({ key }) => {

        if (key === remoteUserId) {

          console.log("[ROOM] Remote user left:", key);

          remoteUserId = null;

          remoteVideo.srcObject = null;

          remotePlaceholder.textContent =
            `Waiting for ${remoteRoleName()}...`;

          remotePlaceholder.style.display =
            "grid";

          setConnectionStatus(
            "Your person left the room."
          );

          closePeerConnection();
        }
      }
    )
    .on(
      "broadcast",
      {
        event: "signal"
      },
      async ({ payload }) => {

        await handleSignal(payload);
      }
    )
    .on(
      "broadcast",
      {
        event: "photo"
      },
      async ({ payload }) => {

        await handlePhotoEvent(payload);
      }
    );


  const status =
    await channel.subscribe(
      async status => {

        if (status === "SUBSCRIBED") {

          console.log(`[ROOM] Joined room ${code} as ${myRole}`);

          await channel.track({
            userId: currentUser.id,
            email: currentUser.email,
            joinedAt: Date.now()
          });

          setRoomStatus(
            `Room ${code} is ready ♡`
          );

        } else if (status === "CHANNEL_ERROR") {

          setRoomStatus(
            "Could not connect to the room."
          );

        }
      }
    );

  if (status === "CHANNEL_ERROR") {
    setRoomStatus(
      "Realtime connection failed."
    );
  }
}


// ---------- WEBRTC ----------

async function getIceServers() {

  if (!TURN_CREDENTIALS_FUNCTION) {
    return STUN_SERVERS;
  }

  if (
    turnServers &&
    Date.now() - turnServersFetchedAt < TURN_CACHE_MS
  ) {
    return [...STUN_SERVERS, ...turnServers];
  }

  try {

    const { data, error } =
      await supabase.functions.invoke(
        TURN_CREDENTIALS_FUNCTION
      );

    if (error) {
      throw error;
    }

    if (!data || !Array.isArray(data.iceServers)) {
      throw new Error("No iceServers in response");
    }

    turnServers = data.iceServers;
    turnServersFetchedAt = Date.now();

    console.log(
      "[WebRTC] TURN configuration fetched:",
      turnServers.length,
      "ICE server entries"
    );

  } catch (error) {

    console.warn(
      "[WebRTC] Could not load TURN credentials, using STUN only:",
      error
    );

    return STUN_SERVERS;
  }

  return [...STUN_SERVERS, ...turnServers];
}


async function startPeerConnection() {

  if (peerConnection) {
    return;
  }

  // Several callers (presence sync/join, incoming signals) can
  // arrive while TURN credentials are loading; share one setup.
  if (!peerConnectionStarting) {
    peerConnectionStarting =
      createPeerConnection().finally(() => {
        peerConnectionStarting = null;
      });
  }

  await peerConnectionStarting;
}


async function createPeerConnection() {

  const iceServers =
    await getIceServers();

  console.log(
    "[WebRTC] ICE servers configured:",
    iceServers.map(server => server.urls)
  );

  peerConnection =
    new RTCPeerConnection({
      iceServers
    });


  if (localStream) {

    localStream
      .getTracks()
      .forEach(track => {

        peerConnection.addTrack(
          track,
          localStream
        );

      });

  }


  peerConnection.onicecandidate =
    async event => {

      if (!event.candidate) {
        return;
      }

      const { type, protocol, address, port } =
        event.candidate;

      console.log(
        "[WebRTC] ICE candidate:",
        type,
        protocol,
        address,
        port
      );

      if (type === "relay") {
        console.log("[WebRTC] TURN/relay candidate detected");
      }

      await sendSignal({
        type: "ice",
        candidate: event.candidate
      });

    };


  peerConnection.ontrack =
    event => {

      console.log(
        "[WebRTC] Remote track received:",
        event.track.kind
      );

      const [stream] =
        event.streams;

      if (!stream) return;

      remoteVideo.srcObject =
        stream;

      remotePlaceholder.style.display =
        "none";

      remoteVideo.play().catch(() => {
        console.log(
          "Remote video needs a user interaction to play."
        );
      });

      setConnectionStatus(
        "You two are connected ♡"
      );

    };


  peerConnection.onconnectionstatechange =
    () => {

      const state =
        peerConnection.connectionState;

      if (state === "connected") {

        setConnectionStatus(
          "You two are connected ♡"
        );

      } else if (
        state === "connecting"
      ) {

        setConnectionStatus(
          "Connecting cameras..."
        );

      } else if (
        state === "disconnected"
      ) {

        setConnectionStatus(
          "Connection interrupted..."
        );

      } else if (
        state === "failed"
      ) {

        setConnectionStatus(
          "Camera connection failed. A TURN server may be needed on this network."
        );

      }

      console.log("[WebRTC] Connection state:", state);

    };


  peerConnection.onicegatheringstatechange =
    () => {
      console.log(
        "[WebRTC] ICE gathering state:",
        peerConnection.iceGatheringState
      );
    };


  peerConnection.oniceconnectionstatechange =
    () => {
      console.log(
        "[WebRTC] ICE connection state:",
        peerConnection.iceConnectionState
      );
    };


  // Reports TURN auth/reachability failures (e.g. bad credentials).
  peerConnection.onicecandidateerror =
    event => {
      console.warn(
        "[WebRTC] ICE candidate error:",
        event.url,
        event.errorCode,
        event.errorText
      );
    };
}


async function makeOffer() {

  if (!peerConnection) {
    return;
  }

  if (makingOffer) {
    return;
  }

  makingOffer = true;

  try {

    console.log("[WEBRTC] Creating offer");

    const offer =
      await peerConnection.createOffer();

    await peerConnection.setLocalDescription(
      offer
    );

    await sendSignal({
      type: "offer",
      sdp: peerConnection.localDescription
    });

  } catch (error) {

    console.error(
      "Offer error:",
      error
    );

  } finally {

    makingOffer = false;

  }
}


async function handleSignal(signal) {

  if (!peerConnection) {
    await startPeerConnection();
  }


  if (signal.type === "offer") {

    console.log("[WEBRTC] Received offer");

    await peerConnection.setRemoteDescription(
      new RTCSessionDescription(signal.sdp)
    );


    const answer =
      await peerConnection.createAnswer();


    await peerConnection.setLocalDescription(
      answer
    );


    console.log("[WEBRTC] Creating answer");

    await sendSignal({

      type: "answer",

      sdp:
        peerConnection.localDescription

    });


    await flushCandidates();

    return;
  }


  if (signal.type === "answer") {

    console.log("[WEBRTC] Received answer");

    await peerConnection.setRemoteDescription(
      new RTCSessionDescription(signal.sdp)
    );

    await flushCandidates();

    return;
  }


  if (signal.type === "renegotiate") {

    // Only the offer-creator (Koko) ever renegotiates, so a
    // late camera-on from BaoBao still never creates an offer
    // herself - she just asks Koko to redo the offer/answer.
    if (myRole === "Koko") {
      await makeOffer();
    }

    return;
  }


  if (signal.type === "ice") {

    console.log("[ICE] ICE candidate received");

    if (
      peerConnection.remoteDescription
    ) {

      try {

        await peerConnection.addIceCandidate(
          signal.candidate
        );

      } catch (error) {

        console.error(
          "ICE error:",
          error
        );

      }

    } else {

      console.log("[ICE] Queuing candidate before remoteDescription is set");

      pendingCandidates.push(
        signal.candidate
      );

    }

  }

}


async function flushCandidates() {

  for (
    const candidate
    of pendingCandidates
  ) {

    try {

      await peerConnection.addIceCandidate(
        candidate
      );

    } catch (error) {

      console.error(
        "Queued ICE error:",
        error
      );

    }

  }

  pendingCandidates = [];
}


async function sendSignal(message) {

  if (!channel) {
    return;
  }

  await channel.send({

    type: "broadcast",

    event: "signal",

    payload: {
      ...message,
      sender: currentUser.id
    }

  });

}


function closePeerConnection() {

  if (!peerConnection) {
    return;
  }

  peerConnection.close();

  peerConnection = null;

  pendingCandidates = [];
}


// ---------- CAMERA ----------

async function startCamera() {

  if (
    !navigator.mediaDevices ||
    !navigator.mediaDevices.getUserMedia
  ) {

    setPhotoStatus(
      window.isSecureContext === false
        ? "Camera needs HTTPS or localhost. Open this page over a secure connection."
        : "Camera access isn't supported in this browser."
    );

    return;
  }

  try {

    if (localStream) {

      localStream
        .getTracks()
        .forEach(
          track => track.stop()
        );

    }


    localStream =
      await navigator.mediaDevices.getUserMedia({

        video: {

          facingMode: "user",

          width: {
            ideal: 1280
          },

          height: {
            ideal: 720
          }

        },

        audio: true

      });


    localVideo.srcObject =
      localStream;

    await localVideo.play();


    captureBtn.disabled =
      !!activeCapture;


    cameraBtn.textContent =
      "Camera On ♡";


    setPhotoStatus(
      "Your camera is ready ♡"
    );


    /*
      If we are already in a room,
      add the camera tracks to WebRTC.
    */

    if (peerConnection) {

      const senders =
        peerConnection.getSenders();


      for (
        const track
        of localStream.getTracks()
      ) {

        const existing =
          senders.find(
            sender =>
              sender.track?.kind === track.kind
          );


        if (existing) {

          await existing.replaceTrack(
            track
          );

        } else {

          peerConnection.addTrack(
            track,
            localStream
          );

        }

      }


      // Only Koko creates offers. If BaoBao just added a new
      // track after the connection was already established,
      // ask Koko to renegotiate instead of offering herself.
      if (myRole === "Koko") {
        await makeOffer();
      } else if (remoteUserId) {
        await sendSignal({ type: "renegotiate" });
      }
    }

  } catch (error) {

    console.error("[CAMERA] getUserMedia error:", error);

    if (error.name === "NotAllowedError") {

      setPhotoStatus(
        "Camera/microphone permission denied. Allow access in your browser settings and try again."
      );

    } else if (
      error.name === "NotFoundError" ||
      error.name === "OverconstrainedError"
    ) {

      setPhotoStatus(
        "No camera or microphone was found on this device."
      );

    } else if (error.name === "NotReadableError") {

      setPhotoStatus(
        "Your camera is already in use by another app."
      );

    } else {

      setPhotoStatus(
        "Could not access your camera. Please check permissions."
      );

    }

  }

}


// ---------- PHOTO ----------

const COUNTDOWN_SECONDS = 5;

const MEMORIES_BUCKET = "memories";
const MEMORIES_LIMIT = 50;
const SIGNED_URL_SECONDS = 60 * 60;

// Final photo layout: two portrait panels side by side,
// with the "our little world" banner underneath.
const PHOTO_PANEL_WIDTH = 660;
const PHOTO_PANEL_HEIGHT = 880;
const PHOTO_PADDING = 40;
const PHOTO_GAP = 20;
const PHOTO_FOOTER = 140;


// Photo events share the room channel with WebRTC signaling
// but use their own broadcast event, so handleSignal() never
// sees them.
async function sendPhotoEvent(message) {

  if (!channel) {
    return;
  }

  try {

    await channel.send({
      type: "broadcast",
      event: "photo",
      payload: {
        ...message,
        sender: currentUser.id
      }
    });

  } catch (error) {

    console.warn("[PHOTO] Could not send photo event:", error);

  }
}


async function handlePhotoEvent(payload) {

  if (payload.type === "countdown") {

    startCountdown({
      captureId: payload.captureId,
      initiatorId: payload.sender
    });

    return;
  }

  if (payload.type === "memory-created") {

    await receiveRemoteMemory(payload.memoryId);

    return;
  }

  if (payload.type === "photo-failed") {

    setPhotoStatus(
      "That photo couldn't be saved this time ♡"
    );

  }
}


// Take Photo: whoever presses it becomes the initiator and is the
// only one who captures, uploads and records the memory.
async function requestPhoto() {

  if (!localStream || activeCapture) {
    return;
  }

  const captureId =
    crypto.randomUUID();

  console.log("[PHOTO] Capture requested", captureId);

  captureBtn.disabled = true;

  // Start locally once the broadcast has been accepted, so both
  // countdowns begin at roughly the same moment.
  await sendPhotoEvent({
    type: "countdown",
    captureId
  });

  if (!currentRoom) {
    return;
  }

  startCountdown({
    captureId,
    initiatorId: currentUser.id
  });
}


function startCountdown({ captureId, initiatorId }) {

  if (activeCapture) {

    if (activeCapture.captureId === captureId) {
      return;
    }

    // Both pressed at nearly the same time. Both devices keep the
    // capture with the smaller id, so exactly one initiator remains.
    if (captureId < activeCapture.captureId) {

      console.log(
        "[PHOTO] Simultaneous capture, initiator is now",
        initiatorId === currentUser.id ? "me" : "remote"
      );

      activeCapture.captureId = captureId;
      activeCapture.initiatorId = initiatorId;
    }

    return;
  }

  activeCapture = {
    captureId,
    initiatorId,
    timers: []
  };

  captureBtn.disabled = true;

  console.log(
    "[PHOTO] Countdown started",
    captureId,
    initiatorId === currentUser.id ? "(initiator)" : "(remote initiator)"
  );

  setPhotoStatus(
    initiatorId === currentUser.id
      ? "Get cozy... smile! ♡"
      : `${remoteRoleName()} is taking a photo... smile! ♡`
  );

  show(countdownOverlay);

  for (let i = 0; i < COUNTDOWN_SECONDS; i++) {

    activeCapture.timers.push(
      setTimeout(
        () => showCountdownNumber(COUNTDOWN_SECONDS - i),
        i * 1000
      )
    );

  }

  activeCapture.timers.push(
    setTimeout(
      finishCountdown,
      COUNTDOWN_SECONDS * 1000
    )
  );
}


function showCountdownNumber(number) {

  console.log(`[PHOTO] Countdown: ${number}`);

  countdownNumber.textContent = number;

  // Restart the pop animation for each number.
  countdownNumber.classList.remove("tick");
  void countdownNumber.offsetWidth;
  countdownNumber.classList.add("tick");
}


function endCountdown() {

  if (activeCapture) {
    activeCapture.timers.forEach(clearTimeout);
  }

  activeCapture = null;

  countdownNumber.textContent = "";

  hide(countdownOverlay);

  captureBtn.disabled = !localStream;
}


function playFlash() {

  flash.classList.remove("active");
  void flash.offsetWidth;
  flash.classList.add("active");
}


async function finishCountdown() {

  const capture = activeCapture;

  if (!capture) {
    return;
  }

  const isInitiator =
    capture.initiatorId === currentUser.id;

  // Grab the frames before the flash and UI changes.
  if (isInitiator) {
    drawCompositePhoto();
  }

  playFlash();

  endCountdown();

  if (isInitiator) {

    await saveCapturedPhoto(capture.captureId);

  } else {

    setPhotoStatus(
      "Developing your photo ♡"
    );

  }
}


function isVideoReady(video) {

  return (
    !!video.srcObject &&
    video.readyState >= 2 &&
    video.videoWidth > 0 &&
    video.videoHeight > 0
  );
}


function clipPhotoPanel(ctx, x, y) {

  ctx.beginPath();

  if (ctx.roundRect) {
    ctx.roundRect(x, y, PHOTO_PANEL_WIDTH, PHOTO_PANEL_HEIGHT, 28);
  } else {
    ctx.rect(x, y, PHOTO_PANEL_WIDTH, PHOTO_PANEL_HEIGHT);
  }

  ctx.clip();
}


// Draws a video frame into a panel, cropped to fill it ("cover")
// and mirrored to match how both videos appear in the booth.
function drawVideoPanel(ctx, video, x, y) {

  const scale = Math.max(
    PHOTO_PANEL_WIDTH / video.videoWidth,
    PHOTO_PANEL_HEIGHT / video.videoHeight
  );

  const sourceWidth = PHOTO_PANEL_WIDTH / scale;
  const sourceHeight = PHOTO_PANEL_HEIGHT / scale;

  const sourceX = (video.videoWidth - sourceWidth) / 2;
  const sourceY = (video.videoHeight - sourceHeight) / 2;

  ctx.save();

  clipPhotoPanel(ctx, x, y);

  ctx.translate(x + PHOTO_PANEL_WIDTH, y);
  ctx.scale(-1, 1);

  ctx.drawImage(
    video,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    0,
    0,
    PHOTO_PANEL_WIDTH,
    PHOTO_PANEL_HEIGHT
  );

  ctx.restore();
}


function drawPlaceholderPanel(ctx, x, y, name) {

  ctx.save();

  clipPhotoPanel(ctx, x, y);

  ctx.fillStyle = "#311d28";
  ctx.fillRect(x, y, PHOTO_PANEL_WIDTH, PHOTO_PANEL_HEIGHT);

  ctx.restore();

  ctx.fillStyle = "#ffd9e9";
  ctx.textAlign = "center";
  ctx.font = "bold 40px Nunito";

  ctx.fillText(
    `${name} ♡`,
    x + PHOTO_PANEL_WIDTH / 2,
    y + PHOTO_PANEL_HEIGHT / 2
  );
}


// Composites both people into the existing canvas.
function drawCompositePhoto() {

  console.log("[PHOTO] Capturing frame");

  const width =
    PHOTO_PADDING * 2 + PHOTO_PANEL_WIDTH * 2 + PHOTO_GAP;

  const height =
    PHOTO_PADDING + PHOTO_PANEL_HEIGHT + PHOTO_FOOTER;

  canvas.width = width;
  canvas.height = height;

  const ctx =
    canvas.getContext("2d");


  /*
    Soft pink card.
  */

  const background =
    ctx.createLinearGradient(0, 0, width, height);

  background.addColorStop(0, "#fff7fb");
  background.addColorStop(1, "#ffd6e8");

  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);


  /*
    Koko always on the left, BaoBao on the right.
  */

  const leftX = PHOTO_PADDING;
  const rightX = PHOTO_PADDING + PHOTO_PANEL_WIDTH + PHOTO_GAP;

  const localOnLeft = myRole !== "BaoBao";

  const panels = [
    {
      video: localVideo,
      x: localOnLeft ? leftX : rightX,
      name: myRole || "You"
    },
    {
      video: remoteVideo,
      x: localOnLeft ? rightX : leftX,
      name: remoteRoleName()
    }
  ];

  for (const panel of panels) {

    if (isVideoReady(panel.video)) {

      drawVideoPanel(ctx, panel.video, panel.x, PHOTO_PADDING);

    } else {

      console.warn(
        "[PHOTO] Video not ready, using placeholder for",
        panel.name
      );

      drawPlaceholderPanel(ctx, panel.x, PHOTO_PADDING, panel.name);

    }

  }


  /*
    Pink tint.
  */

  ctx.fillStyle =
    "rgba(255, 111, 174, 0.12)";

  ctx.fillRect(
    0,
    0,
    width,
    height
  );


  /*
    Couple name.
  */

  ctx.textAlign =
    "center";

  ctx.fillStyle =
    "#e94f92";

  ctx.font =
    "bold 60px Nunito";

  ctx.fillText(
    "our little world",
    width / 2,
    PHOTO_PADDING + PHOTO_PANEL_HEIGHT + 78
  );

  ctx.fillStyle =
    "#b07991";

  ctx.font =
    "bold 26px Nunito";

  ctx.fillText(
    new Date().toLocaleDateString(undefined, {
      year: "numeric",
      month: "long",
      day: "numeric"
    }),
    width / 2,
    PHOTO_PADDING + PHOTO_PANEL_HEIGHT + 118
  );

  console.log("[PHOTO] Composite created", `${width}x${height}`);
}


// Initiator only: export the composite, upload it, record the
// memory, then tell the other person it's ready.
async function saveCapturedPhoto(memoryId) {

  const roomCode = currentRoom;

  const blob =
    await new Promise(resolve =>
      canvas.toBlob(resolve, "image/jpeg", 0.92)
    );

  if (!blob) {

    console.error("[PHOTO] Could not export JPEG");

    setPhotoStatus(
      "Could not create the photo. Please try again."
    );

    await sendPhotoEvent({ type: "photo-failed" });

    return;
  }

  // Available to Save Photo even if the upload fails.
  const url =
    URL.createObjectURL(blob);

  latestPhoto = url;
  downloadBtn.disabled = false;

  setPhotoStatus(
    "Saving your memory..."
  );

  try {

    const photoPath =
      `${roomCode}/${memoryId}.jpg`;

    const { error: uploadError } =
      await supabase.storage
        .from(MEMORIES_BUCKET)
        .upload(photoPath, blob, {
          contentType: "image/jpeg",
          upsert: false
        });

    if (uploadError) {
      throw uploadError;
    }

    console.log("[PHOTO] Upload successful", photoPath);

    const { data: memory, error: insertError } =
      await supabase
        .from("memories")
        .insert({
          id: memoryId,
          room_code: roomCode,
          created_by: currentUser.id,
          photo_path: photoPath
        })
        .select()
        .single();

    if (insertError) {
      throw insertError;
    }

    console.log("[PHOTO] Memory created", memory.id);

    addMemory(
      { ...memory, url },
      { reveal: true }
    );

    setPhotoStatus(
      "A new little memory ♡"
    );

    await sendPhotoEvent({
      type: "memory-created",
      memoryId: memory.id
    });

  } catch (error) {

    console.error("[PHOTO] Could not save memory:", error);

    setPhotoStatus(
      "Couldn't save to Memories, but you can still use Save Photo ♡"
    );

    await sendPhotoEvent({ type: "photo-failed" });

  }
}


// ---------- SHARED MEMORIES ----------

// Records that this user is in the room (which is what grants
// access to its memories), then loads the room's memories.
async function prepareMemories(code) {

  try {

    const { error } =
      await supabase
        .from("room_members")
        .upsert(
          {
            room_code: code,
            user_id: currentUser.id
          },
          {
            onConflict: "room_code,user_id",
            ignoreDuplicates: true
          }
        );

    if (error) {
      throw error;
    }

    await loadMemories(code);

  } catch (error) {

    console.error("[PHOTO] Could not load shared memories:", error);

    if (code === currentRoom) {
      gallery.innerHTML =
        '<div class="empty">Couldn\'t load your memories right now ♡</div>';
    }

  }
}


async function loadMemories(code) {

  const { data: rows, error } =
    await supabase
      .from("memories")
      .select("*")
      .eq("room_code", code)
      .order("created_at", { ascending: false })
      .limit(MEMORIES_LIMIT);

  if (error) {
    throw error;
  }

  if (code !== currentRoom) {
    return;
  }

  const urls = {};

  if (rows.length) {

    const { data: signed, error: signError } =
      await supabase.storage
        .from(MEMORIES_BUCKET)
        .createSignedUrls(
          rows.map(row => row.photo_path),
          SIGNED_URL_SECONDS
        );

    if (signError) {
      throw signError;
    }

    signed.forEach(item => {
      if (item.signedUrl) {
        urls[item.path] = item.signedUrl;
      }
    });

  }

  if (code !== currentRoom) {
    return;
  }

  // Keep anything that arrived over Realtime while loading.
  const known =
    new Set(memories.map(memory => memory.id));

  rows.forEach(row => {

    if (!known.has(row.id) && urls[row.photo_path]) {
      memories.push({ ...row, url: urls[row.photo_path] });
    }

  });

  memories.sort(
    (a, b) => new Date(b.created_at) - new Date(a.created_at)
  );

  renderGallery();
}


// The other person saved a memory. Re-read the row (RLS confirms
// it belongs to our room) instead of trusting the broadcast.
async function receiveRemoteMemory(memoryId) {

  if (!memoryId || memories.some(memory => memory.id === memoryId)) {
    return;
  }

  console.log("[PHOTO] Remote memory received", memoryId);

  try {

    const { data: memory, error } =
      await supabase
        .from("memories")
        .select("*")
        .eq("id", memoryId)
        .single();

    if (error) {
      throw error;
    }

    const { data: blob, error: downloadError } =
      await supabase.storage
        .from(MEMORIES_BUCKET)
        .download(memory.photo_path);

    if (downloadError) {
      throw downloadError;
    }

    const url =
      URL.createObjectURL(blob);

    if (addMemory({ ...memory, url }, { reveal: true })) {

      latestPhoto = url;
      downloadBtn.disabled = false;

      setPhotoStatus(
        "A new little memory ♡"
      );

    }

  } catch (error) {

    console.error("[PHOTO] Could not load remote memory:", error);

    setPhotoStatus(
      "A new memory was saved, but it couldn't load here. Rejoin the booth to see it ♡"
    );

  }
}


// Adds one memory to the top of the gallery. Returns false for a
// duplicate or a memory from another room.
function addMemory(memory, { reveal = false } = {}) {

  if (
    memory.room_code !== currentRoom ||
    memories.some(existing => existing.id === memory.id)
  ) {
    return false;
  }

  memories.unshift(memory);

  if (memories.length === 1) {
    gallery.innerHTML = "";
  }

  gallery.prepend(
    createPhotoElement(memory, reveal)
  );

  return true;
}


// ---------- GALLERY ----------

function createPhotoElement(memory, reveal = false) {

  const div =
    document.createElement("div");

  div.className =
    reveal ? "photo reveal" : "photo";

  const img =
    document.createElement("img");

  img.src = memory.url;
  img.alt = "our little world memory";

  div.appendChild(img);

  return div;
}


function renderGallery() {

  gallery.innerHTML = "";


  if (!memories.length) {

    gallery.innerHTML = currentRoom
      ? '<div class="empty">No photos yet ♡</div>'
      : '<div class="empty">Join a booth to see your memories ♡</div>';

    return;
  }


  memories.forEach(memory => {
    gallery.appendChild(
      createPhotoElement(memory)
    );
  });
}


function downloadPhoto() {

  if (!latestPhoto) {
    return;
  }


  const link =
    document.createElement("a");


  link.href =
    latestPhoto;


  link.download =
    `koko-baobao-${Date.now()}.jpg`;


  link.click();
}


// ---------- LEAVE ROOM ----------

// keepRole: true when called from enterRoom(), where myRole was
// already set by createRoom()/joinRoom() for the room we're
// about to join - it must not be wiped out here.
async function leaveRoom({ keepRole = false } = {}) {

  endCountdown();

  closePeerConnection();

  makingOffer = false;


  if (localStream) {

    localStream
      .getTracks()
      .forEach(
        track => track.stop()
      );

    localStream = null;
  }


  localVideo.srcObject =
    null;

  remoteVideo.srcObject =
    null;


  remotePlaceholder.style.display =
    "grid";


  if (channel) {

    try {
      await channel.untrack();
    } catch (_) {}

    try {
      await supabase.removeChannel(
        channel
      );
    } catch (_) {}

  }


  channel = null;
  currentRoom = null;
  remoteUserId = null;

  memories = [];
  renderGallery();

  if (!keepRole) {
    myRole = null;
  }

  updateRoleUI();

  hide(videoCard);

  setRoomStatus(
    "Create a booth or enter a code."
  );

  setConnectionStatus(
    `Waiting for ${remoteRoleName()}...`
  );

  cameraBtn.textContent =
    "Turn On Camera";

  captureBtn.disabled =
    true;
}


// ---------- EVENTS ----------

signupBtn.addEventListener(
  "click",
  signUp
);

loginBtn.addEventListener(
  "click",
  login
);

logoutBtn.addEventListener(
  "click",
  logout
);

createRoomBtn.addEventListener(
  "click",
  createRoom
);

joinRoomBtn.addEventListener(
  "click",
  joinRoom
);

leaveRoomBtn.addEventListener(
  "click",
  leaveRoom
);

cameraBtn.addEventListener(
  "click",
  startCamera
);

captureBtn.addEventListener(
  "click",
  requestPhoto
);

downloadBtn.addEventListener(
  "click",
  downloadPhoto
);


// Allow Enter key in room input.
roomCodeInput.addEventListener(
  "keydown",
  event => {

    if (event.key === "Enter") {
      joinRoom();
    }

  }
);


// Stop camera and drop presence when leaving the page, so a
// refresh/close doesn't leave a stale participant in the room.
window.addEventListener(
  "pagehide",
  () => {

    if (localStream) {

      localStream
        .getTracks()
        .forEach(
          track => track.stop()
        );

    }

    if (channel) {
      try {
        channel.untrack();
      } catch (_) {}
    }

  }
);


// ---------- START ----------

renderGallery();
checkSession();

})();
