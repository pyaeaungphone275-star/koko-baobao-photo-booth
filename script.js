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

const shotIndicator = document.getElementById("shotIndicator");
const developingText = document.getElementById("developingText");
const frameSelector = document.getElementById("frameSelector");
const beautySelector = document.getElementById("beautySelector");
const stripReveal = document.getElementById("stripReveal");
const stripImage = document.getElementById("stripImage");


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
let latestPhotoDate = null;

// This device's frame and beauty choice. The session initiator's
// choice is the one used for the strip.
let photoSettings = {
  frame: "hearts",
  beauty: "natural"
};

// Shared memories for the current room, newest first.
// Each entry is a public.memories row plus a displayable `url`.
let memories = [];

// The running synchronized 3-shot session, if any:
// { captureId, initiatorId, roomCode, settings, shots,
//   phase: "countdown" | "developing", timers }
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

// One Take Photo press starts one session of SHOT_COUNT shots.
// Each shot is a COUNTDOWN_SECONDS countdown, a flash, then a
// short pause before the next shot's countdown begins.
const SHOT_COUNT = 3;
const SHOT_PAUSE_MS = 1800;
const SHOT_INTERVAL_MS = COUNTDOWN_SECONDS * 1000 + SHOT_PAUSE_MS;

// How long the other person waits for the finished strip before
// Take Photo is re-enabled anyway.
const DEVELOPING_TIMEOUT_MS = 45000;

const MEMORIES_BUCKET = "memories";
const MEMORIES_LIMIT = 50;
const SIGNED_URL_SECONDS = 60 * 60;

// Matches the bucket's file_size_limit.
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

// Final strip layout: SHOT_COUNT shots stacked vertically, each
// holding both people side by side, with the "our little world"
// footer underneath.
const STRIP_WIDTH = 1200;
const STRIP_PADDING = 60;
const SHOT_WIDTH = STRIP_WIDTH - STRIP_PADDING * 2;
const SHOT_HEIGHT = 810;
const SHOT_GAP = 44;
const SHOT_DIVIDER = 8;
const PERSON_WIDTH = (SHOT_WIDTH - SHOT_DIVIDER) / 2;
const STRIP_FOOTER = 250;

const STRIP_HEIGHT =
  STRIP_PADDING +
  SHOT_COUNT * SHOT_HEIGHT +
  (SHOT_COUNT - 1) * SHOT_GAP +
  STRIP_FOOTER;

const FRAME_STYLES = ["hearts", "roses", "letter"];

// radius/epsilon drive the edge-preserving smoothing (bigger =
// smoother, but strong edges like eyes and hair are always kept).
// smoothing is the most that is ever blended in, so some natural
// skin texture always remains.
const BEAUTY_LEVELS = {
  natural: { radius: 4, epsilon: 140, smoothing: 0.55, evenTone: 0.35, brighten: 0.045 },
  soft: { radius: 6, epsilon: 320, smoothing: 0.75, evenTone: 0.5, brighten: 0.07 },
  off: null
};

const PHOTO_SETTINGS_KEY = "our-little-world-photo-settings";


// ---------- PHOTO OPTIONS ----------

function loadPhotoSettings() {

  try {

    const saved =
      JSON.parse(localStorage.getItem(PHOTO_SETTINGS_KEY));

    if (saved && FRAME_STYLES.includes(saved.frame)) {
      photoSettings.frame = saved.frame;
    }

    if (saved && Object.prototype.hasOwnProperty.call(BEAUTY_LEVELS, saved.beauty)) {
      photoSettings.beauty = saved.beauty;
    }

  } catch (_) {}
}


function savePhotoSettings() {

  try {
    localStorage.setItem(
      PHOTO_SETTINGS_KEY,
      JSON.stringify(photoSettings)
    );
  } catch (_) {}
}


function updatePhotoOptionsUI() {

  frameSelector
    .querySelectorAll("[data-frame]")
    .forEach(chip => {
      chip.setAttribute(
        "aria-checked",
        chip.dataset.frame === photoSettings.frame
      );
    });

  beautySelector
    .querySelectorAll("[data-beauty]")
    .forEach(button => {
      button.setAttribute(
        "aria-checked",
        button.dataset.beauty === photoSettings.beauty
      );
    });
}


function setPhotoOptionsDisabled(disabled) {

  frameSelector
    .querySelectorAll("button")
    .forEach(button => { button.disabled = disabled; });

  beautySelector
    .querySelectorAll("button")
    .forEach(button => { button.disabled = disabled; });
}


function selectFrame(event) {

  const chip =
    event.target.closest("[data-frame]");

  if (!chip || chip.disabled) {
    return;
  }

  photoSettings.frame = chip.dataset.frame;

  savePhotoSettings();
  updatePhotoOptionsUI();
}


function selectBeauty(event) {

  const button =
    event.target.closest("[data-beauty]");

  if (!button || button.disabled) {
    return;
  }

  photoSettings.beauty = button.dataset.beauty;

  savePhotoSettings();
  updatePhotoOptionsUI();
}


// Each chip previews its frame using the same drawing code as
// the final strip, on a stand-in "photo".
function renderFramePreviews() {

  frameSelector
    .querySelectorAll("[data-frame]")
    .forEach(chip => {

      const preview =
        chip.querySelector("canvas");

      const ctx =
        preview.getContext("2d");

      const style = chip.dataset.frame;

      const w = preview.width;
      const h = preview.height;

      drawStripBackground(ctx, style, w, h, 0.3);

      const x = 16;
      const y = 14;
      const shotW = w - 32;
      const shotH = h - 28;

      ctx.save();

      roundRectPath(ctx, x, y, shotW, shotH, 6);
      ctx.clip();

      const photo =
        ctx.createLinearGradient(0, y, 0, y + shotH);

      photo.addColorStop(0, "#f8dbe6");
      photo.addColorStop(1, "#ecbcd0");

      ctx.fillStyle = photo;
      ctx.fillRect(x, y, shotW, shotH);

      // Two little people.
      ctx.fillStyle = "#fff5f9";

      for (const cx of [x + shotW * 0.3, x + shotW * 0.7]) {

        ctx.beginPath();
        ctx.arc(cx, y + shotH * 0.45, shotH * 0.15, 0, Math.PI * 2);
        ctx.fill();

        ctx.beginPath();
        ctx.ellipse(cx, y + shotH * 1.02, shotH * 0.3, shotH * 0.36, 0, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.restore();

      drawFrameDecor(ctx, style, x, y, shotW, shotH, 0.28);
    });
}


// ---------- PHOTO SESSION ----------

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

    finishDeveloping();

    setPhotoStatus(
      "That photo strip couldn't be saved this time ♡"
    );

  }
}


// Take Photo: whoever presses it becomes the initiator and is the
// only one who captures, builds the strip, uploads it and records
// the memory. The other device just follows the countdown.
async function requestPhoto() {

  if (!localStream || activeCapture || !currentRoom) {
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


// Runs the whole 3-shot session on this device. Both devices run
// the same schedule from the same "countdown" event.
function startCountdown({ captureId, initiatorId }) {

  if (activeCapture) {

    if (activeCapture.captureId === captureId) {
      return;
    }

    if (
      activeCapture.phase === "developing" &&
      activeCapture.initiatorId !== currentUser.id
    ) {

      // We were still waiting on the last strip, but the other
      // person has already started a new session.
      endCountdown();

    } else {

      // Both pressed at nearly the same time. Both devices keep the
      // session with the smaller id, so exactly one initiator remains.
      if (
        activeCapture.phase === "countdown" &&
        activeCapture.shots.length === 0 &&
        captureId < activeCapture.captureId
      ) {

        console.log(
          "[PHOTO] Simultaneous capture, initiator is now",
          initiatorId === currentUser.id ? "me" : "remote"
        );

        activeCapture.captureId = captureId;
        activeCapture.initiatorId = initiatorId;
      }

      return;
    }
  }

  const capture = {
    captureId,
    initiatorId,
    roomCode: currentRoom,
    settings: { ...photoSettings },
    shots: [],
    phase: "countdown",
    timers: []
  };

  activeCapture = capture;

  captureBtn.disabled = true;
  setPhotoOptionsDisabled(true);

  hide(stripReveal);
  hide(developingText);

  console.log(
    "[PHOTO] Session started",
    captureId,
    initiatorId === currentUser.id ? "(initiator)" : "(remote initiator)"
  );

  setPhotoStatus(
    initiatorId === currentUser.id
      ? "Get cozy... 3 photos coming up! ♡"
      : `${remoteRoleName()} started the photo booth... smile! ♡`
  );

  show(countdownOverlay);

  const schedule = (callback, delay) => {
    capture.timers.push(setTimeout(callback, delay));
  };

  for (let shot = 1; shot <= SHOT_COUNT; shot++) {

    const shotStart =
      (shot - 1) * SHOT_INTERVAL_MS;

    schedule(() => beginShot(shot), shotStart);

    for (let i = 0; i < COUNTDOWN_SECONDS; i++) {

      schedule(
        () => showCountdownNumber(COUNTDOWN_SECONDS - i),
        shotStart + i * 1000
      );

    }

    schedule(
      () => takeShot(shot),
      shotStart + COUNTDOWN_SECONDS * 1000
    );

    if (shot < SHOT_COUNT) {
      schedule(
        () => { countdownNumber.textContent = ""; },
        shotStart + COUNTDOWN_SECONDS * 1000 + 900
      );
    }
  }

  schedule(
    finishCountdown,
    (SHOT_COUNT - 1) * SHOT_INTERVAL_MS + COUNTDOWN_SECONDS * 1000 + 900
  );
}


function beginShot(shot) {

  console.log(`[PHOTO] Shot ${shot} of ${SHOT_COUNT}`);

  shotIndicator.textContent =
    `SHOT ${shot} OF ${SHOT_COUNT}`;
}


function showCountdownNumber(number) {

  console.log(`[PHOTO] Countdown: ${number}`);

  countdownNumber.textContent = number;

  // Restart the pop animation for each number.
  countdownNumber.classList.remove("tick");
  void countdownNumber.offsetWidth;
  countdownNumber.classList.add("tick");
}


function takeShot(shot) {

  const capture = activeCapture;

  if (!capture) {
    return;
  }

  // Grab the frames before the flash and UI changes.
  if (capture.initiatorId === currentUser.id) {

    console.log("[PHOTO] Capturing shot", shot);

    capture.shots.push(
      captureShotFrame()
    );

  }

  showCountdownNumber("📸");

  playFlash();
}


function endCountdown() {

  if (activeCapture) {
    activeCapture.timers.forEach(clearTimeout);
  }

  activeCapture = null;

  countdownNumber.textContent = "";
  shotIndicator.textContent = "";

  hide(developingText);
  hide(countdownOverlay);

  captureBtn.disabled = !localStream;

  setPhotoOptionsDisabled(false);
}


function playFlash() {

  flash.classList.remove("active");
  void flash.offsetWidth;
  flash.classList.add("active");
}


function waitForPaint() {

  return new Promise(resolve => setTimeout(resolve, 50));
}


// After the last shot: show "developing", then the initiator builds
// and saves the strip while the other device waits for it.
async function finishCountdown() {

  const capture = activeCapture;

  if (!capture) {
    return;
  }

  capture.phase = "developing";

  capture.timers.forEach(clearTimeout);
  capture.timers = [];

  countdownNumber.textContent = "";
  shotIndicator.textContent = "";

  show(developingText);

  setPhotoStatus(
    "developing our little memory ♡"
  );

  if (capture.initiatorId !== currentUser.id) {

    capture.timers.push(
      setTimeout(() => {

        if (activeCapture === capture) {

          endCountdown();

          setPhotoStatus(
            "The strip is taking a while... it'll show up in Memories ♡"
          );

        }

      }, DEVELOPING_TIMEOUT_MS)
    );

    return;
  }

  // Let "developing" paint before the heavy pixel work.
  await waitForPaint();

  try {

    await createPhotoStrip(capture);

  } catch (error) {

    console.error("[PHOTO] Could not create the photo strip:", error);

    if (activeCapture === capture) {
      endCountdown();
    }

    setPhotoStatus(
      "Could not create the photo strip. Please try again."
    );

    await sendPhotoEvent({ type: "photo-failed" });

    return;
  }

  await saveCapturedPhoto(capture);

  if (activeCapture === capture) {
    endCountdown();
  }
}


// The other device's session ends once the strip arrives (or the
// initiator reports a failure).
function finishDeveloping() {

  if (
    activeCapture &&
    activeCapture.phase === "developing" &&
    activeCapture.initiatorId !== currentUser.id
  ) {
    endCountdown();
  }
}


function showStrip(url) {

  hide(developingText);
  hide(countdownOverlay);

  stripImage.src = url;

  // Restart the reveal animation.
  hide(stripReveal);
  void stripReveal.offsetWidth;
  show(stripReveal);
}


// ---------- CAPTURE ----------

function isVideoReady(video) {

  return (
    !!video.srcObject &&
    video.readyState >= 2 &&
    video.videoWidth > 0 &&
    video.videoHeight > 0
  );
}


// Draws a video frame into an area, cropped to fill it ("cover")
// and mirrored to match how both videos appear in the booth.
function drawVideoPanel(ctx, video, x, y, width, height) {

  const scale = Math.max(
    width / video.videoWidth,
    height / video.videoHeight
  );

  const sourceWidth = width / scale;
  const sourceHeight = height / scale;

  const sourceX = (video.videoWidth - sourceWidth) / 2;
  const sourceY = (video.videoHeight - sourceHeight) / 2;

  ctx.save();

  ctx.beginPath();
  ctx.rect(x, y, width, height);
  ctx.clip();

  ctx.translate(x + width, y);
  ctx.scale(-1, 1);

  ctx.drawImage(
    video,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    0,
    0,
    width,
    height
  );

  ctx.restore();
}


function drawPlaceholderPanel(ctx, x, y, width, height, name) {

  ctx.fillStyle = "#311d28";
  ctx.fillRect(x, y, width, height);

  ctx.fillStyle = "#ffd9e9";
  ctx.textAlign = "center";
  ctx.font = "bold 40px Nunito";

  ctx.fillText(
    `${name} ♡`,
    x + width / 2,
    y + height / 2
  );
}


// Grabs one shot (both people, Koko on the left and BaoBao on the
// right) into its own canvas. Only cheap drawing happens here so
// the countdown and WebRTC stay smooth; beauty and frames are
// applied after the last shot.
function captureShotFrame() {

  const shot =
    document.createElement("canvas");

  shot.width = SHOT_WIDTH;
  shot.height = SHOT_HEIGHT;

  const ctx =
    shot.getContext("2d", { willReadFrequently: true });

  const leftX = 0;
  const rightX = PERSON_WIDTH + SHOT_DIVIDER;

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

      drawVideoPanel(ctx, panel.video, panel.x, 0, PERSON_WIDTH, SHOT_HEIGHT);

    } else {

      console.warn(
        "[PHOTO] Video not ready, using placeholder for",
        panel.name
      );

      drawPlaceholderPanel(ctx, panel.x, 0, PERSON_WIDTH, SHOT_HEIGHT, panel.name);

    }

  }

  return shot;
}


// ---------- BEAUTY ----------

// 0..1 within [low, high], fading to 0 over `fade` outside it.
function softRange(value, low, high, fade) {

  if (value < low) {
    return Math.max(0, 1 - (low - value) / fade);
  }

  if (value > high) {
    return Math.max(0, 1 - (value - high) / fade);
  }

  return 1;
}


// How skin-like a colour is (0..1), using the widely used YCbCr
// skin range, which works across skin tones and ignores most hair,
// eyes, clothes and backgrounds.
function skinScore(r, g, b) {

  const luma = 0.299 * r + 0.587 * g + 0.114 * b;
  const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
  const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;

  return (
    softRange(cb, 77, 127, 8) *
    softRange(cr, 135, 172, 6) *
    softRange(luma, 45, 250, 20)
  );
}


// Mean over a (2r+1)x(2r+1) box around every pixel, via a summed
// area table so it costs the same for any radius.
function boxMean(source, width, height, radius) {

  const stride = width + 1;

  const table =
    new Float64Array(stride * (height + 1));

  for (let y = 0; y < height; y++) {

    let rowSum = 0;

    for (let x = 0; x < width; x++) {

      rowSum += source[y * width + x];

      table[(y + 1) * stride + x + 1] =
        table[y * stride + x + 1] + rowSum;
    }
  }

  const result =
    new Float32Array(width * height);

  for (let y = 0; y < height; y++) {

    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(height, y + radius + 1);

    for (let x = 0; x < width; x++) {

      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(width, x + radius + 1);

      const sum =
        table[y1 * stride + x1] -
        table[y0 * stride + x1] -
        table[y1 * stride + x0] +
        table[y0 * stride + x0];

      result[y * width + x] =
        sum / ((x1 - x0) * (y1 - y0));
    }
  }

  return result;
}


// Subtle, skin-only retouch of one area of a captured shot:
//  1. a soft, feathered mask of smooth skin-coloured areas (nothing
//     outside it is touched),
//  2. an edge-preserving guided filter, which flattens small bumps
//     and blemishes but keeps eyes, brows, lips and hair edges,
//  3. gentle evening of local redness (blemishes) and a slight
//     brightening, all scaled by the mask.
function applyBeauty(ctx, x, y, width, height, level) {

  const image =
    ctx.getImageData(x, y, width, height);

  const data = image.data;
  const count = width * height;

  const luma = new Float32Array(count);
  const lumaSquared = new Float32Array(count);

  for (let i = 0, p = 0; i < count; i++, p += 4) {
    const value = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
    luma[i] = value;
    lumaSquared[i] = value * value;
  }

  // Skin is smooth; hair, brows, lashes and fabric are textured. Some
  // hair shares skin's colour, so busy areas are left out of the mask.
  const lumaMean = boxMean(luma, width, height, 3);
  const lumaMeanSquared = boxMean(lumaSquared, width, height, 3);

  const mask = new Float32Array(count);
  let skinPixels = 0;

  for (let i = 0, p = 0; i < count; i++, p += 4) {

    const deviation = Math.sqrt(
      Math.max(0, lumaMeanSquared[i] - lumaMean[i] * lumaMean[i])
    );

    const smoothness =
      1 - Math.min(1, Math.max(0, (deviation - 9) / 14));

    mask[i] =
      skinScore(data[p], data[p + 1], data[p + 2]) * smoothness;

    if (mask[i] > 0.5) {
      skinPixels++;
    }
  }

  // No visible skin (camera off, very dark frame...).
  if (skinPixels < count * 0.005) {
    return false;
  }

  const softMask =
    boxMean(mask, width, height, 6);

  const channel = new Float32Array(count);
  const squared = new Float32Array(count);
  const a = new Float32Array(count);
  const b = new Float32Array(count);

  const smoothed = [];
  const localMean = [];

  for (let c = 0; c < 3; c++) {

    for (let i = 0; i < count; i++) {
      const value = data[i * 4 + c];
      channel[i] = value;
      squared[i] = value * value;
    }

    const mean = boxMean(channel, width, height, level.radius);
    const meanSquared = boxMean(squared, width, height, level.radius);

    for (let i = 0; i < count; i++) {
      const variance = meanSquared[i] - mean[i] * mean[i];
      a[i] = variance / (variance + level.epsilon);
      b[i] = mean[i] * (1 - a[i]);
    }

    const meanA = boxMean(a, width, height, level.radius);
    const meanB = boxMean(b, width, height, level.radius);

    const output = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      output[i] = meanA[i] * channel[i] + meanB[i];
    }

    smoothed.push(output);

    // Wider neighbourhood for judging "redder than the skin around it".
    if (c < 2) {
      localMean.push(
        boxMean(channel, width, height, level.radius * 3)
      );
    }
  }

  for (let i = 0, p = 0; i < count; i++, p += 4) {

    const m = softMask[i];

    if (m < 0.02) {
      continue;
    }

    const smoothing = m * level.smoothing;

    let r = data[p] + (smoothed[0][i] - data[p]) * smoothing;
    let g = data[p + 1] + (smoothed[1][i] - data[p + 1]) * smoothing;
    let bl = data[p + 2] + (smoothed[2][i] - data[p + 2]) * smoothing;

    // Capped so naturally red areas such as lips keep their colour.
    const redness =
      (data[p] - data[p + 1]) - (localMean[0][i] - localMean[1][i]);

    if (redness > 0) {
      r -= Math.min(redness, 20) * level.evenTone * m;
    }

    const lift = level.brighten * m;

    r += (255 - r) * lift;
    g += (255 - g) * lift;
    bl += (255 - bl) * lift;

    data[p] = r;
    data[p + 1] = g;
    data[p + 2] = bl;
  }

  ctx.putImageData(image, x, y);

  return true;
}


// ---------- FRAMES ----------

function roundRectPath(ctx, x, y, width, height, radius) {

  ctx.beginPath();

  if (ctx.roundRect) {
    ctx.roundRect(x, y, width, height, radius);
  } else {
    ctx.rect(x, y, width, height);
  }
}


function drawHeart(ctx, cx, cy, size, color, rotation = 0) {

  const k = size / 2;

  ctx.save();

  ctx.translate(cx, cy);
  ctx.rotate(rotation);

  ctx.beginPath();
  ctx.moveTo(0, k * 0.75);
  ctx.bezierCurveTo(-k * 1.25, -k * 0.05, -k * 0.6, -k * 1.05, 0, -k * 0.42);
  ctx.bezierCurveTo(k * 0.6, -k * 1.05, k * 1.25, -k * 0.05, 0, k * 0.75);
  ctx.closePath();

  ctx.fillStyle = color;
  ctx.fill();

  ctx.restore();
}


function drawSparkle(ctx, cx, cy, radius, color) {

  ctx.beginPath();
  ctx.moveTo(cx, cy - radius);
  ctx.quadraticCurveTo(cx, cy, cx + radius, cy);
  ctx.quadraticCurveTo(cx, cy, cx, cy + radius);
  ctx.quadraticCurveTo(cx, cy, cx - radius, cy);
  ctx.quadraticCurveTo(cx, cy, cx, cy - radius);

  ctx.fillStyle = color;
  ctx.fill();
}


function drawLeaf(ctx, x, y, length, angle, color) {

  ctx.save();

  ctx.translate(x, y);
  ctx.rotate(angle);

  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.quadraticCurveTo(length * 0.5, -length * 0.36, length, 0);
  ctx.quadraticCurveTo(length * 0.5, length * 0.36, 0, 0);

  ctx.fillStyle = color;
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(length * 0.08, 0);
  ctx.lineTo(length * 0.82, 0);

  ctx.strokeStyle = "rgba(255, 255, 255, 0.55)";
  ctx.lineWidth = Math.max(1, length * 0.035);
  ctx.stroke();

  ctx.restore();
}


const ROSE_PINK = { outer: "#f9b8cc", inner: "#f48fb1", line: "#d9668f" };
const ROSE_BLUSH = { outer: "#fde0e8", inner: "#f9c5d5", line: "#e891ad" };


function drawRose(ctx, cx, cy, radius, colors, turn = 0) {

  ctx.fillStyle = colors.outer;

  for (let i = 0; i < 5; i++) {

    const angle = turn + (i * Math.PI * 2) / 5;

    ctx.beginPath();
    ctx.ellipse(
      cx + Math.cos(angle) * radius * 0.45,
      cy + Math.sin(angle) * radius * 0.45,
      radius * 0.55,
      radius * 0.42,
      angle,
      0,
      Math.PI * 2
    );
    ctx.fill();
  }

  ctx.beginPath();
  ctx.arc(cx, cy, radius * 0.56, 0, Math.PI * 2);
  ctx.fillStyle = colors.inner;
  ctx.fill();

  // Swirl of the inner petals.
  ctx.beginPath();

  const turns = Math.PI * 3.2;

  for (let t = 0; t <= turns; t += 0.15) {

    const r = radius * (0.05 + (t / turns) * 0.46);

    const px = cx + Math.cos(t + turn) * r;
    const py = cy + Math.sin(t + turn) * r;

    if (t === 0) {
      ctx.moveTo(px, py);
    } else {
      ctx.lineTo(px, py);
    }
  }

  ctx.strokeStyle = colors.line;
  ctx.lineWidth = Math.max(1, radius * 0.08);
  ctx.lineCap = "round";
  ctx.stroke();
}


function drawBow(ctx, cx, cy, size, color, knotColor) {

  ctx.fillStyle = color;

  for (const dir of [-1, 1]) {

    // Loop.
    ctx.beginPath();
    ctx.ellipse(
      cx + dir * size * 0.55,
      cy - size * 0.12,
      size * 0.58,
      size * 0.36,
      -dir * 0.35,
      0,
      Math.PI * 2
    );
    ctx.fill();

    // Tail.
    ctx.beginPath();
    ctx.moveTo(cx - dir * size * 0.04, cy);
    ctx.lineTo(cx + dir * size * 0.5, cy + size * 0.95);
    ctx.lineTo(cx + dir * size * 0.28, cy + size * 0.86);
    ctx.lineTo(cx + dir * size * 0.16, cy + size * 1.0);
    ctx.closePath();
    ctx.fill();
  }

  ctx.beginPath();
  ctx.arc(cx, cy, size * 0.2, 0, Math.PI * 2);
  ctx.fillStyle = knotColor;
  ctx.fill();
}


// The strip's paper. `scale` lets the small previews reuse it.
function drawStripBackground(ctx, style, width, height, scale = 1) {

  if (style === "letter") {

    ctx.fillStyle = "#fffaf7";
    ctx.fillRect(0, 0, width, height);

    // Faint writing-paper lines.
    ctx.strokeStyle = "#f8e4ec";
    ctx.lineWidth = Math.max(1, 2 * scale);

    for (let y = 40 * scale; y < height; y += 40 * scale) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    return;
  }

  const background =
    ctx.createLinearGradient(0, 0, width, height);

  if (style === "roses") {
    background.addColorStop(0, "#fffaf5");
    background.addColorStop(1, "#fde2ea");
  } else {
    background.addColorStop(0, "#fff7fb");
    background.addColorStop(1, "#ffd6e8");
  }

  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);
}


// Border and corner decorations for one shot. Everything stays on
// the edges and corners (mostly over the strip's margin) so faces
// are never covered. `s` scales the decorations.
function drawFrameDecor(ctx, style, x, y, w, h, s = 1) {

  ctx.save();

  ctx.shadowColor = "rgba(189, 71, 123, 0.25)";
  ctx.shadowBlur = 8 * s;
  ctx.shadowOffsetY = 2 * s;

  if (style === "roses") {

    roundRectPath(ctx, x, y, w, h, 26 * s);
    ctx.strokeStyle = "#fde4ec";
    ctx.lineWidth = 10 * s;
    ctx.stroke();

    roundRectPath(ctx, x - 9 * s, y - 9 * s, w + 18 * s, h + 18 * s, 32 * s);
    ctx.strokeStyle = "#f7b6cb";
    ctx.lineWidth = 2.5 * s;
    ctx.stroke();

    // Top-left bouquet.
    drawLeaf(ctx, x + 6 * s, y + 20 * s, 78 * s, Math.PI / 2 + 0.25, "#a8d5a2");
    drawLeaf(ctx, x + 22 * s, y + 4 * s, 78 * s, -0.2, "#8fc79a");
    drawRose(ctx, x + 6 * s, y + 6 * s, 42 * s, ROSE_PINK, 0.3);
    drawRose(ctx, x + 66 * s, y - 10 * s, 24 * s, ROSE_BLUSH, 1.2);

    // Bottom-right bouquet.
    drawLeaf(ctx, x + w - 6 * s, y + h - 20 * s, 78 * s, -Math.PI / 2 + 0.25, "#a8d5a2");
    drawLeaf(ctx, x + w - 22 * s, y + h - 4 * s, 78 * s, Math.PI - 0.2, "#8fc79a");
    drawRose(ctx, x + w - 6 * s, y + h - 6 * s, 42 * s, ROSE_PINK, 2.1);
    drawRose(ctx, x + w - 66 * s, y + h + 10 * s, 24 * s, ROSE_BLUSH, 0.6);

    // Tiny hearts on the quiet corners.
    drawHeart(ctx, x + w - 8 * s, y + 4 * s, 26 * s, "#f6a5c0", 0.25);
    drawHeart(ctx, x + 8 * s, y + h - 4 * s, 22 * s, "#f9c5d5", -0.25);

  } else if (style === "letter") {

    roundRectPath(ctx, x, y, w, h, 18 * s);
    ctx.strokeStyle = "#f7a8c8";
    ctx.lineWidth = 6 * s;
    ctx.stroke();

    ctx.shadowColor = "transparent";

    // Little stitched line just inside the border.
    roundRectPath(ctx, x + 14 * s, y + 14 * s, w - 28 * s, h - 28 * s, 10 * s);
    ctx.setLineDash([14 * s, 10 * s]);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.75)";
    ctx.lineWidth = 2.5 * s;
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.shadowColor = "rgba(189, 71, 123, 0.25)";

    // Bow on the top edge, between the two people.
    drawBow(ctx, x + w / 2, y + 2 * s, 46 * s, "#f48fb1", "#e26a9a");

    drawHeart(ctx, x + 6 * s, y + h - 4 * s, 42 * s, "#f7a8c8", -0.3);
    drawHeart(ctx, x + w - 6 * s, y + h - 4 * s, 42 * s, "#f7a8c8", 0.3);

  } else {

    roundRectPath(ctx, x, y, w, h, 26 * s);
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 10 * s;
    ctx.stroke();

    roundRectPath(ctx, x - 10 * s, y - 10 * s, w + 20 * s, h + 20 * s, 34 * s);
    ctx.strokeStyle = "#ffb3d1";
    ctx.lineWidth = 3 * s;
    ctx.stroke();

    // Top-left cluster.
    drawHeart(ctx, x + 8 * s, y + 12 * s, 66 * s, "#ff8fbf", -0.3);
    drawHeart(ctx, x + 70 * s, y - 8 * s, 34 * s, "#ffc2db", 0.25);
    drawSparkle(ctx, x + 112 * s, y + 18 * s, 15 * s, "#fff0f7");
    drawSparkle(ctx, x + 20 * s, y + 84 * s, 11 * s, "#ffd6e7");

    // Bottom-right cluster.
    drawHeart(ctx, x + w - 10 * s, y + h - 12 * s, 60 * s, "#ff8fbf", 0.3);
    drawHeart(ctx, x + w - 70 * s, y + h + 8 * s, 30 * s, "#ffc2db", -0.2);
    drawSparkle(ctx, x + w - 112 * s, y + h - 16 * s, 14 * s, "#fff0f7");
    drawSparkle(ctx, x + w - 18 * s, y + h - 84 * s, 10 * s, "#ffd6e7");

    // A few tiny sparkles on the other corners.
    drawSparkle(ctx, x + w - 14 * s, y + 14 * s, 13 * s, "#ffe3ef");
    drawSparkle(ctx, x + w - 46 * s, y - 6 * s, 8 * s, "#ffd6e7");
    drawHeart(ctx, x + 12 * s, y + h - 10 * s, 24 * s, "#ffc2db", -0.2);
  }

  ctx.restore();
}


function drawFramedShot(ctx, shot, x, y, style) {

  ctx.save();

  roundRectPath(ctx, x, y, SHOT_WIDTH, SHOT_HEIGHT, style === "letter" ? 18 : 26);
  ctx.clip();

  ctx.drawImage(shot, x, y);

  // Soft pink wash.
  ctx.fillStyle = "rgba(255, 111, 174, 0.06)";
  ctx.fillRect(x, y, SHOT_WIDTH, SHOT_HEIGHT);

  ctx.restore();

  drawFrameDecor(ctx, style, x, y, SHOT_WIDTH, SHOT_HEIGHT);
}


function drawStripFooter(ctx, style) {

  const footerTop =
    STRIP_HEIGHT - STRIP_FOOTER;

  const titleY = footerTop + 128;
  const dateY = footerTop + 188;

  ctx.textAlign = "center";

  ctx.fillStyle = "#e94f92";
  ctx.font = "76px Pacifico, cursive";

  ctx.fillText(
    "our little world",
    STRIP_WIDTH / 2,
    titleY
  );

  const titleWidth =
    ctx.measureText("our little world").width;

  ctx.fillStyle = "#b07991";
  ctx.font = "bold 30px Nunito";

  ctx.fillText(
    new Date().toLocaleDateString(undefined, {
      year: "numeric",
      month: "long",
      day: "numeric"
    }),
    STRIP_WIDTH / 2,
    dateY
  );

  // A small accent on each side of the title.
  const sideOffset = titleWidth / 2 + 52;

  for (const dir of [-1, 1]) {

    const cx = STRIP_WIDTH / 2 + dir * sideOffset;
    const cy = titleY - 24;

    if (style === "roses") {
      drawRose(ctx, cx, cy, 20, ROSE_PINK, dir);
    } else if (style === "letter") {
      drawBow(ctx, cx, cy - 6, 22, "#f7a8c8", "#e26a9a");
    } else {
      drawHeart(ctx, cx, cy, 34, "#ff8fbf", dir * 0.25);
    }
  }
}


// ---------- STRIP ----------

// Initiator only: retouches the 3 shots, frames them and lays out
// the final strip in the existing canvas.
async function createPhotoStrip(capture) {

  if (capture.shots.length !== SHOT_COUNT) {
    throw new Error(
      `Expected ${SHOT_COUNT} shots, got ${capture.shots.length}`
    );
  }

  const { frame, beauty } = capture.settings;

  const level = BEAUTY_LEVELS[beauty];

  if (level) {

    for (const shot of capture.shots) {

      const shotCtx =
        shot.getContext("2d", { willReadFrequently: true });

      applyBeauty(shotCtx, 0, 0, PERSON_WIDTH, SHOT_HEIGHT, level);
      applyBeauty(shotCtx, PERSON_WIDTH + SHOT_DIVIDER, 0, PERSON_WIDTH, SHOT_HEIGHT, level);

      // Keep the page responsive between shots.
      await waitForPaint();
    }

    console.log("[PHOTO] Beauty effect applied", beauty);

  } else {

    console.log("[PHOTO] Beauty effect off");

  }

  try {
    await document.fonts.load("76px Pacifico");
  } catch (_) {}

  canvas.width = STRIP_WIDTH;
  canvas.height = STRIP_HEIGHT;

  const ctx =
    canvas.getContext("2d");

  drawStripBackground(ctx, frame, STRIP_WIDTH, STRIP_HEIGHT);

  capture.shots.forEach((shot, index) => {

    drawFramedShot(
      ctx,
      shot,
      STRIP_PADDING,
      STRIP_PADDING + index * (SHOT_HEIGHT + SHOT_GAP),
      frame
    );

  });

  console.log("[PHOTO] Frame applied", frame);

  drawStripFooter(ctx, frame);

  console.log("[PHOTO] Final strip created", `${STRIP_WIDTH}x${STRIP_HEIGHT}`);
}


function exportCanvas(quality) {

  return new Promise(resolve =>
    canvas.toBlob(resolve, "image/jpeg", quality)
  );
}


// Initiator only: export the strip, upload it, record the memory,
// then tell the other person it's ready.
async function saveCapturedPhoto(capture) {

  const roomCode = capture.roomCode;
  const memoryId = capture.captureId;

  let blob =
    await exportCanvas(0.92);

  // Stay under the bucket's size limit.
  if (blob && blob.size > MAX_UPLOAD_BYTES) {
    blob = await exportCanvas(0.82);
  }

  if (!blob) {

    console.error("[PHOTO] Could not export JPEG");

    setPhotoStatus(
      "Could not create the photo strip. Please try again."
    );

    await sendPhotoEvent({ type: "photo-failed" });

    return;
  }

  // Available to Save Photo even if the upload fails.
  const url =
    URL.createObjectURL(blob);

  latestPhoto = url;
  latestPhotoDate = new Date();
  downloadBtn.disabled = false;

  showStrip(url);

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
      latestPhotoDate = new Date(memory.created_at);
      downloadBtn.disabled = false;

      showStrip(url);

      setPhotoStatus(
        "A new little memory ♡"
      );

    }

    finishDeveloping();

  } catch (error) {

    console.error("[PHOTO] Could not load remote memory:", error);

    finishDeveloping();

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


// our-little-world-YYYY-MM-DD.jpg (local date).
function photoFileName(date) {

  const pad = number =>
    String(number).padStart(2, "0");

  return `our-little-world-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.jpg`;
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
    photoFileName(latestPhotoDate || new Date());


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

  hide(stripReveal);

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

frameSelector.addEventListener(
  "click",
  selectFrame
);

beautySelector.addEventListener(
  "click",
  selectBeauty
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

loadPhotoSettings();
updatePhotoOptionsUI();
renderFramePreviews();

renderGallery();
checkSession();

})();
