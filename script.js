/*
==========================================================
KOKO & BAOBAO REMOTE PHOTO BOOTH

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

const cameraBtn = document.getElementById("cameraBtn");
const captureBtn = document.getElementById("captureBtn");
const downloadBtn = document.getElementById("downloadBtn");

const connectionStatus = document.getElementById("connectionStatus");
const photoStatus = document.getElementById("photoStatus");

const canvas = document.getElementById("canvas");

const gallery = document.getElementById("gallery");
const clearBtn = document.getElementById("clearBtn");


// ---------- STATE ----------

let currentUser = null;
let currentRoom = null;
let channel = null;

let localStream = null;
let peerConnection = null;

let remoteUserId = null;
let makingOffer = false;

let pendingCandidates = [];

let latestPhoto = null;

let photos = JSON.parse(
  localStorage.getItem("kokoBaoBaoPhotos") || "[]"
);


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

  currentUser = null;

  hide(roomCard);
  hide(videoCard);
  hide(memoriesCard);
  show(authCard);

  setAuthStatus("Logged out ♡");
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
      currentUser = null;
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

  await enterRoom(code, true);
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

  await enterRoom(code, false);
}


async function enterRoom(code, isCreator) {

  await leaveRoom();

  currentRoom = code;

  roomCodeInput.value = code;

  setRoomStatus(
    `Connecting to room ${code}...`
  );

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

          remoteUserId = others[0];

          setRoomStatus(
            "Your person is here ♡"
          );

          setConnectionStatus(
            "Connecting your cameras..."
          );

          await startPeerConnection();

          if (isCreator) {
            await makeOffer();
          }

        } else {

          remoteUserId = null;

          setRoomStatus(
            `Room ${code} is ready. Send the code to your person ♡`
          );

          setConnectionStatus(
            "Waiting for your person..."
          );
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

        remoteUserId = key;

        setRoomStatus(
          "Your person joined ♡"
        );

        setConnectionStatus(
          "Connecting your cameras..."
        );

        await startPeerConnection();

        // The person who was already in the room
        // makes the offer.
        await makeOffer();
      }
    )
    .on(
      "presence",
      {
        event: "leave"
      },
      ({ key }) => {

        if (key === remoteUserId) {

          remoteUserId = null;

          remoteVideo.srcObject = null;

          remotePlaceholder.textContent =
            "Waiting for BaoBao...";

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
    );


  const status =
    await channel.subscribe(
      async status => {

        if (status === "SUBSCRIBED") {

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

async function startPeerConnection() {

  if (peerConnection) {
    return;
  }


  /*
    Google STUN helps browsers discover
    their public network address.

    For the most reliable connection across
    restrictive networks, add a TURN server
    to the iceServers list later.
  */

  peerConnection =
    new RTCPeerConnection({

      iceServers: [

        {
          urls:
            "stun:stun.l.google.com:19302"
        }

      ]

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

      await sendSignal({
        type: "ice",
        candidate: event.candidate
      });

    };


  peerConnection.ontrack =
    event => {

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

    await peerConnection.setRemoteDescription(
      new RTCSessionDescription(signal.sdp)
    );


    const answer =
      await peerConnection.createAnswer();


    await peerConnection.setLocalDescription(
      answer
    );


    await sendSignal({

      type: "answer",

      sdp:
        peerConnection.localDescription

    });


    await flushCandidates();

    return;
  }


  if (signal.type === "answer") {

    await peerConnection.setRemoteDescription(
      new RTCSessionDescription(signal.sdp)
    );

    await flushCandidates();

    return;
  }


  if (signal.type === "ice") {

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
      false;


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


      await makeOffer();
    }

  } catch (error) {

    console.error(error);

    setPhotoStatus(
      "Please allow camera and microphone access."
    );

  }

}


// ---------- PHOTO ----------

function takePhoto() {

  if (!localStream) {
    return;
  }


  const width =
    localVideo.videoWidth;

  const height =
    localVideo.videoHeight;


  if (!width || !height) {
    return;
  }


  canvas.width =
    width;

  canvas.height =
    height;


  const ctx =
    canvas.getContext("2d");


  /*
    Draw local camera.
  */

  ctx.save();

  ctx.translate(
    width,
    0
  );

  ctx.scale(-1, 1);

  ctx.drawImage(
    localVideo,
    0,
    0,
    width,
    height
  );

  ctx.restore();


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

  ctx.fillStyle =
    "#ffffff";

  ctx.font =
    `bold ${Math.max(
      24,
      width * 0.035
    )}px Nunito`;

  ctx.textAlign =
    "center";


  ctx.fillText(
    "Koko ♡ BaoBao <3",
    width / 2,
    height - 25
  );


  latestPhoto =
    canvas.toDataURL(
      "image/jpeg",
      0.92
    );


  photos.push(
    latestPhoto
  );


  if (photos.length > 20) {
    photos.shift();
  }


  localStorage.setItem(
    "kokoBaoBaoPhotos",
    JSON.stringify(photos)
  );


  downloadBtn.disabled =
    false;


  setPhotoStatus(
    "A new little memory ♡"
  );


  renderGallery();
}


// ---------- GALLERY ----------

function renderGallery() {

  gallery.innerHTML = "";


  if (!photos.length) {

    gallery.innerHTML =
      '<div class="empty">No photos yet ♡</div>';

    return;
  }


  photos
    .slice()
    .reverse()
    .forEach(src => {

      const div =
        document.createElement("div");

      div.className =
        "photo";


      div.innerHTML = `
        <img
          src="${src}"
          alt="Koko and BaoBao memory"
        >
      `;


      gallery.appendChild(div);

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


function clearPhotos() {

  if (!photos.length) {
    return;
  }


  if (
    !confirm(
      "Clear all your little memories?"
    )
  ) {
    return;
  }


  photos = [];


  localStorage.removeItem(
    "kokoBaoBaoPhotos"
  );


  renderGallery();


  setPhotoStatus(
    "Memories cleared ♡"
  );
}


// ---------- LEAVE ROOM ----------

async function leaveRoom() {

  closePeerConnection();


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

  hide(videoCard);

  setRoomStatus(
    "Create a booth or enter a code."
  );

  setConnectionStatus(
    "Waiting for your person..."
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
  takePhoto
);

downloadBtn.addEventListener(
  "click",
  downloadPhoto
);

clearBtn.addEventListener(
  "click",
  clearPhotos
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


// Stop camera when leaving page.
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

  }
);


// ---------- START ----------

renderGallery();
checkSession();

})();
