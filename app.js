import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getFirestore,
  doc,
  setDoc,
  updateDoc,
  onSnapshot,
  runTransaction,
  serverTimestamp,
  getDoc,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';

// ── Firebase ──────────────────────────────────────────────────────────────────
const app = initializeApp(firebaseConfig);
const db  = getFirestore(app);

// ── Constants ─────────────────────────────────────────────────────────────────
const VOTE_SECS   = 30;
const REVEAL_SECS = 8;
const MIN_PLAYERS = 4;
const MAX_PLAYERS = 20;
const ROUNDS      = 10;

const ALL_QUESTIONS = [
  // custom
  "Most likely to lose their voice networking at GDC",
  "Most likely to secure a job offer at a Game Dev Drink Up",
  "Most likely to turn a major bug into an 'intended feature'",
  "Most likely to submit a Game Jam build at the final second",
  "Most likely to build a custom engine instead of finishing the game",
  "Most likely to survive a 48-hour jam on nothing but boba and caffeine",
  "Most likely to blame a loss on server tick rate",
  "Most likely to accidentally leak an unannounced project during a screen share",
  "Most likely to have a LinkedIn connection with every Perk-Up speaker",
  "Most likely to be the 'carry' in every casual e-sports match",
  "Most likely to spend more time on their RGB setup than their code",
  "Most likely to own 50+ unplayed indie games on Steam",
  "Most likely to find a game-breaking exploit in a professional tournament",
  "Most likely to have a 'committing code at 4 AM' sleep schedule",
  "Most likely to be the last one standing at the Drink Up",
  "Most likely to be 'arriving in 5 mins' for three hours",
  "Most likely to start an argument about which noodle soup place is best",
  "Most likely to accidentally start a cult while trying to explain game lore",
  "Most likely to spend their entire paycheck on 'The Edit' hotel upgrades",
  "Most likely to forget they were screen sharing while looking at memes",
  "Most likely to spend 20 minutes deciding what to order on Uber Eats",
  "Most likely to have more empty boba cups than completed Jira tickets",
  "Most likely to get a noise complaint for their mechanical keyboard",
  "Most likely to be late to their own birthday party",
  "Most likely to treat a casual board game night like a Grand Finals match",
  // originals
  "Most likely to accidentally start a religion",
  "Most likely to sleep through their own wedding",
  "Most likely to befriend a wild bear and never tell anyone",
  "Most likely to be quoted ironically on a motivational poster",
  "Most likely to time-travel and immediately cause a paradox",
  "Most likely to survive the apocalypse (but definitely cause it)",
  "Most likely to become everyone's unpaid therapist",
  "Most likely to go viral for the completely wrong reason",
  "Most likely to make van life look unironically aspirational",
  "Most likely to be a secret billionaire",
  "Most likely to invent something world-changing while procrastinating",
  "Most likely to have a Wikipedia page with three unsourced controversies",
  "Most likely to convince you of absolutely anything",
  "Most likely to show up 2 hours early and still somehow be late",
  "Most likely to own a secret island",
  "Most likely to be mistaken for a celebrity in another country",
  "Most likely to become a licensed nap consultant",
  "Most likely to know a guy who knows every guy",
  "Most likely to accidentally discover a new species",
];

const EMOJIS = [
  '🎮','🎯','🏆','🎲','🃏',
  '🦊','🐉','🦁','🐺','🦝',
  '👾','🤖','👻','💀','🎃',
  '🧙','🦸','🧛','🤡','🎪',
  '🔥','⚡','💥','🌙','⭐',
  '💎','👑','🎩','🧋','🍕',
];

// ── Session state ─────────────────────────────────────────────────────────────
let myId            = null;
let myName          = '';
let myEmoji         = EMOJIS[0];
let roomCode        = '';
let unsubscribeRoom = null;
let votingTimer     = null;
let revealTimer     = null;
let lastRound       = -1;     // tracks which round we last initialised timers for
let hasVoted        = false;
let advanceLocked   = false;  // rate-limit advance calls from this client

// ── Helpers ───────────────────────────────────────────────────────────────────
const uid  = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
const esc  = (s) => { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; };
const $    = (id) => document.getElementById(id);

function genRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(el => el.classList.remove('active'));
  $(id).classList.add('active');
}

function clearTimers() {
  clearInterval(votingTimer);
  clearInterval(revealTimer);
  votingTimer = revealTimer = null;
}

function showError(msg) {
  const el = $('join-error');
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 4500);
}

// ── Join / Create ─────────────────────────────────────────────────────────────
async function joinOrCreate(name, code) {
  myId   = uid();
  myName = name;

  const isNew  = !code;
  roomCode     = isNew ? genRoomCode() : code.toUpperCase().trim();
  const ref    = doc(db, 'rooms', roomCode);

  if (isNew) {
    await setDoc(ref, {
      state:        'lobby',
      host:         myId,
      currentRound: 0,
      questions:    [],
      timerStart:   null,
      currentVotes: {},
      roundResults: [],
      players: {
        [myId]: { name, emoji: myEmoji, score: 0, awards: [] },
      },
    });
  } else {
    const snap = await getDoc(ref);
    if (!snap.exists())                                    { showError('Room not found. Check the code.'); return; }
    if (snap.data().state !== 'lobby')                    { showError('That game has already started.'); return; }
    if (Object.keys(snap.data().players).length >= MAX_PLAYERS) { showError('Room is full (10 players max).'); return; }

    await updateDoc(ref, {
      [`players.${myId}`]: { name, emoji: myEmoji, score: 0, awards: [] },
    });
  }

  setRoomCodeInUrl(roomCode);
  showScreen('screen-lobby');
  subscribe();
}

// ── Firestore listener ────────────────────────────────────────────────────────
function subscribe() {
  if (unsubscribeRoom) unsubscribeRoom();
  unsubscribeRoom = onSnapshot(doc(db, 'rooms', roomCode), snap => {
    if (!snap.exists()) return;
    const data = snap.data();
    switch (data.state) {
      case 'lobby':       renderLobby(data);       break;
      case 'voting':      renderVoting(data);      break;
      case 'reveal':      renderReveal(data);      break;
      case 'leaderboard': renderLeaderboard(data); break;
    }
  });
}

// ── Start game (host) ─────────────────────────────────────────────────────────
async function startGame() {
  const snap = await getDoc(doc(db, 'rooms', roomCode));
  if (!snap.exists()) return;
  const data = snap.data();
  if (Object.keys(data.players).length < MIN_PLAYERS) return;

  await updateDoc(doc(db, 'rooms', roomCode), {
    state:        'voting',
    currentRound: 0,
    currentVotes: {},
    questions:    shuffle(ALL_QUESTIONS).slice(0, ROUNDS),
    timerStart:   serverTimestamp(),
  });
}

// ── Vote ──────────────────────────────────────────────────────────────────────
async function castVote(nomineeId) {
  if (hasVoted) return;
  hasVoted = true;
  await updateDoc(doc(db, 'rooms', roomCode), {
    [`currentVotes.${myId}`]: nomineeId,
  });
}

// ── Scoring ───────────────────────────────────────────────────────────────────
function calcResults(votes, players) {
  const pids   = Object.keys(players);
  const counts = Object.fromEntries(pids.map(id => [id, 0]));

  for (const vid of Object.values(votes)) {
    if (counts[vid] !== undefined) counts[vid]++;
  }

  const maxVotes = Math.max(0, ...Object.values(counts));
  if (maxVotes === 0) {
    return { isTie: true, winnerId: null, winnerName: null, earners: [], isUnanimous: false, counts };
  }

  const top = pids.filter(id => counts[id] === maxVotes);
  if (top.length > 1) {
    return { isTie: true, winnerId: null, winnerName: null, earners: [], isUnanimous: false, counts };
  }

  const winnerId   = top[0];
  const earners    = Object.entries(votes).filter(([, v]) => v === winnerId).map(([k]) => k);
  const isUnanimous = Object.keys(votes).length === pids.length && earners.length === pids.length;

  return { isTie: false, winnerId, winnerName: players[winnerId].name, earners, isUnanimous, counts };
}

// ── Advance: voting → reveal (transaction, any client, safe) ─────────────────
async function advanceToReveal() {
  if (advanceLocked) return;
  advanceLocked = true;

  try {
    await runTransaction(db, async tx => {
      const snap = await tx.get(doc(db, 'rooms', roomCode));
      const data = snap.data();
      if (data.state !== 'voting') return;

      const res  = calcResults(data.currentVotes, data.players);
      const q    = data.questions[data.currentRound];

      // Update scores & award stamps
      const players = structuredClone(data.players);
      if (!res.isTie && res.winnerId) {
        for (const eid of res.earners) {
          if (players[eid]) players[eid].score += 100;
        }
        players[res.winnerId].awards = [...(players[res.winnerId].awards || []), q];
      }

      tx.update(doc(db, 'rooms', roomCode), {
        state:        'reveal',
        players,
        roundResults: [
          ...(data.roundResults || []),
          { question: q, ...res },
        ],
      });
    });
  } catch (err) {
    console.error('advanceToReveal:', err);
    advanceLocked = false;
  }
}

// ── Advance: reveal → next round or leaderboard (transaction) ─────────────────
async function advanceFromReveal() {
  try {
    await runTransaction(db, async tx => {
      const snap = await tx.get(doc(db, 'rooms', roomCode));
      const data = snap.data();
      if (data.state !== 'reveal') return;

      const next = data.currentRound + 1;
      if (next >= ROUNDS) {
        tx.update(doc(db, 'rooms', roomCode), { state: 'leaderboard' });
      } else {
        tx.update(doc(db, 'rooms', roomCode), {
          state:        'voting',
          currentRound: next,
          currentVotes: {},
          timerStart:   serverTimestamp(),
        });
      }
    });
  } catch (err) {
    console.error('advanceFromReveal:', err);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  RENDER — LOBBY
// ══════════════════════════════════════════════════════════════════════════════
function renderLobby(data) {
  showScreen('screen-lobby');
  clearTimers();
  hasVoted = false;
  advanceLocked = false;
  lastRound = -1;

  const players = data.players || {};
  const pids    = Object.keys(players);

  $('lobby-room-code').textContent = roomCode;
  $('lobby-count').textContent     = `${pids.length} / ${MAX_PLAYERS}`;

  // QR code — set once per room
  const qrImg = $('lobby-qr-img');
  if (qrImg.dataset.code !== roomCode) {
    qrImg.dataset.code = roomCode;
    const joinUrl = `${location.origin}${location.pathname}?room=${roomCode}`;
    $('lobby-join-url').textContent = joinUrl;
    qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(joinUrl)}&color=c89b3c&bgcolor=010a13&margin=6`;
  }

  $('lobby-players-grid').innerHTML = pids.map(pid => `
    <div class="hextech-panel p-3 text-center relative"
         style="clip-path:polygon(8px 0%,calc(100% - 8px) 0%,100% 8px,100% calc(100% - 8px),calc(100% - 8px) 100%,8px 100%,0% calc(100% - 8px),0% 8px);">
      <div class="text-2xl mb-1">${players[pid].emoji || '🎮'}</div>
      <div class="text-xs font-semibold truncate">${esc(players[pid].name)}</div>
      ${pid === data.host ? `<div class="mt-0.5" style="color:#c89b3c;font-size:0.55rem;letter-spacing:.1em;">HOST</div>` : ''}
      ${pid === myId    ? `<div class="mt-0.5" style="color:#0ac8b9;font-size:0.55rem;">(you)</div>` : ''}
    </div>
  `).join('');

  $('lobby-need-more').classList.toggle('hidden', pids.length >= MIN_PLAYERS);

  const amHost = data.host === myId;
  $('btn-start').classList.toggle('hidden', !amHost);
  $('lobby-host-label').classList.toggle('hidden', !amHost);
  $('lobby-guest-label').classList.toggle('hidden', amHost);
  $('btn-start').disabled = pids.length < MIN_PLAYERS;
}

// ══════════════════════════════════════════════════════════════════════════════
//  RENDER — VOTING
// ══════════════════════════════════════════════════════════════════════════════
function renderVoting(data) {
  const round   = data.currentRound;
  const players = data.players || {};
  const votes   = data.currentVotes || {};
  const pids    = Object.keys(players);

  // Reset state on a new round
  if (round !== lastRound) {
    lastRound     = round;
    hasVoted      = !!(votes[myId]);
    advanceLocked = false;
    clearTimers();
  }

  // serverTimestamp() resolves to null on the first local snapshot, then a real
  // Timestamp on the next one — start the timer whenever it becomes available.
  if (!votingTimer && data.timerStart) {
    startVotingTimer(data.timerStart);
  }

  showScreen('screen-voting');

  $('v-round').textContent    = round + 1;
  $('v-question').textContent = data.questions[round] || '';
  $('v-my-name').textContent  = myName;

  const myVote   = votes[myId];
  const votesDone = Object.keys(votes).length;
  $('v-status').textContent = myVote
    ? `You voted for ${esc(players[myVote]?.name ?? '?')} · ${votesDone}/${pids.length} votes in`
    : `${votesDone}/${pids.length} votes in — tap a card to vote`;

  $('nominees-grid').innerHTML = pids.map((pid, i) => {
    const isSelected = myVote === pid;
    const isDisabled = !!myVote && !isSelected;
    const votesFor   = Object.values(votes).filter(v => v === pid).length;

    return `
      <div class="nominee-card ${isSelected ? 'card-selected' : ''} ${isDisabled ? 'card-disabled' : ''}"
           style="--glint-delay:${i * 0.4}s"
           data-pid="${pid}">
        <div class="text-center w-full">
          <div class="text-3xl mb-1">${players[pid].emoji || '🎮'}</div>
          <div class="font-semibold text-sm truncate">${esc(players[pid].name)}</div>
          ${myVote ? `<div class="text-xs mt-1" style="color:#c89b3c88;">${votesFor > 0 ? `${votesFor} vote${votesFor > 1 ? 's' : ''}` : '—'}</div>` : ''}
          ${isSelected ? `<div class="text-xs mt-1" style="color:#0ac8b9;font-size:0.65rem;letter-spacing:.08em;">✓ YOUR VOTE</div>` : ''}
        </div>
      </div>
    `;
  }).join('');

  // Advance when all votes are in
  if (votesDone >= pids.length) advanceToReveal();
}

function startVotingTimer(timerStart) {
  const startMs = timerStart.toMillis ? timerStart.toMillis() : Date.now();
  const bar     = $('timer-bar');
  const num     = $('timer-num');

  votingTimer = setInterval(() => {
    const elapsed   = (Date.now() - startMs) / 1000;
    const remaining = Math.max(0, VOTE_SECS - elapsed);
    const pct       = (remaining / VOTE_SECS) * 100;

    bar.style.width = pct + '%';
    num.textContent = Math.ceil(remaining);
    bar.classList.toggle('urgent', remaining <= 10);

    if (remaining <= 0) {
      clearInterval(votingTimer);
      advanceToReveal();
    }
  }, 250);
}

// ══════════════════════════════════════════════════════════════════════════════
//  RENDER — REVEAL
// ══════════════════════════════════════════════════════════════════════════════
function renderReveal(data) {
  showScreen('screen-reveal');
  clearTimers();

  const round   = data.currentRound;
  const result  = data.roundResults?.[round];
  const players = data.players || {};
  if (!result) return;

  $('r-round').textContent    = round + 1;
  $('r-question').textContent = result.question;

  const card = $('r-card');

  if (result.isTie) {
    $('r-winner-block').classList.add('hidden');
    $('r-stalemate-block').classList.remove('hidden');
    card.classList.add('stalemate-glow');
    card.classList.remove('anim-level-up');

    const maxVotes = Math.max(0, ...Object.values(result.counts || {}));
    const tiedNames = Object.entries(result.counts || {})
      .filter(([, c]) => c === maxVotes && c > 0)
      .map(([id]) => players[id]?.name ?? id)
      .join(', ');
    $('r-stalemate-detail').textContent = tiedNames ? `Tied: ${tiedNames}` : '';
  } else {
    $('r-winner-block').classList.remove('hidden');
    $('r-stalemate-block').classList.add('hidden');
    card.classList.remove('stalemate-glow');
    card.classList.add('anim-level-up');

    const winnerEmoji = result.winnerId ? (players[result.winnerId]?.emoji || '🎮') : '';
    $('r-winner-name').innerHTML = `<div class="text-5xl mb-2">${winnerEmoji}</div>${esc(result.winnerName ?? '')}`;

    const earnerNames = (result.earners ?? [])
      .map(id => players[id]?.name ?? id)
      .join(', ');
    $('r-earners').textContent = earnerNames || 'No one';

    const breakdown = Object.entries(result.counts ?? {})
      .filter(([, c]) => c > 0)
      .sort(([, a], [, b]) => b - a)
      .map(([id, c]) => `${players[id]?.name ?? id}: ${c}`)
      .join(' · ');
    $('r-breakdown').textContent = breakdown;

    if (result.isUnanimous) triggerMasteryBurst();
  }

  // 8-second countdown then advance
  let remaining = REVEAL_SECS;
  $('r-countdown').textContent = remaining;
  revealTimer = setInterval(() => {
    remaining--;
    $('r-countdown').textContent = remaining;
    if (remaining <= 0) {
      clearInterval(revealTimer);
      advanceFromReveal();
    }
  }, 1000);
}

// ══════════════════════════════════════════════════════════════════════════════
//  RENDER — LEADERBOARD
// ══════════════════════════════════════════════════════════════════════════════
function renderLeaderboard(data) {
  showScreen('screen-leaderboard');
  clearTimers();

  const players = data.players || {};
  const results = data.roundResults || [];
  const sorted  = Object.entries(players).sort(([, a], [, b]) => b.score - a.score);

  const rankRoman = ['I', 'II', 'III'];
  const rankClass = ['rank-1', 'rank-2', 'rank-3'];

  // ── Left: points ranking ──────────────────────────────────────────────────
  $('leaderboard-list').innerHTML = sorted.map(([pid, p], idx) => {
    const rank   = idx + 1;
    const rClass = rank <= 3 ? rankClass[idx] : 'rank-other';
    const rLabel = rank <= 3 ? rankRoman[idx] : rank;
    const isMe   = pid === myId;
    const delay  = idx * 0.08;

    return `
      <div class="rank-row ${rClass} anim-fade-in-up" style="animation-delay:${delay}s;">
        <div class="hextech-panel p-3 relative">
          <div class="corner corner-tl"></div>
          <div class="corner corner-tr"></div>
          <div class="corner corner-bl"></div>
          <div class="corner corner-br"></div>
          ${isMe ? `<div style="position:absolute;inset:0;background:rgba(10,200,185,0.04);pointer-events:none;"></div>` : ''}
          <div class="flex items-center gap-3">
            <div class="rank-badge">${rLabel}</div>
            <div class="text-2xl flex-shrink-0">${p.emoji || '🎮'}</div>
            <span class="flex-1 font-semibold truncate">
              ${esc(p.name)}${isMe ? ' <span style="color:#0ac8b9;font-size:0.7rem;">(you)</span>' : ''}
            </span>
            <span class="flex-shrink-0 font-bold text-sm" style="color:#c89b3c;">${p.score} pts</span>
          </div>
        </div>
      </div>`;
  }).join('');

  // ── Right: awards table ───────────────────────────────────────────────────
  $('awards-table').innerHTML = results.map((r, idx) => {
    const delay      = idx * 0.06;
    const winner     = r.isTie ? null : r.winnerName;
    const shortQ     = r.question.replace(/^Most likely to /i, '');

    return `
      <div class="hextech-panel p-3 relative anim-fade-in-up" style="animation-delay:${delay}s;">
        <div class="corner corner-tl"></div>
        <div class="corner corner-tr"></div>
        <div class="corner corner-bl"></div>
        <div class="corner corner-br"></div>
        <div class="text-xs mb-1 leading-snug" style="color:#c89b3c88;">${esc(shortQ)}</div>
        ${winner
          ? `<div class="font-semibold text-sm truncate" style="color:#e8d9b0;">${esc(winner)}</div>`
          : `<div class="text-xs italic" style="color:#ff555566;">— Stalemate —</div>`
        }
      </div>`;
  }).join('');
}

// ── Mastery burst (unanimous win) ─────────────────────────────────────────────
function triggerMasteryBurst() {
  const overlay = $('mastery-overlay');
  overlay.classList.remove('hidden');
  setTimeout(() => overlay.classList.add('hidden'), 2200);
}

// ── URL helpers ───────────────────────────────────────────────────────────────
function getRoomCodeFromUrl() {
  return new URLSearchParams(window.location.search).get('room')?.toUpperCase() || '';
}

function setRoomCodeInUrl(code) {
  const url = new URL(window.location.href);
  url.searchParams.set('room', code);
  history.pushState({}, '', url);
}

function clearRoomCodeFromUrl() {
  const url = new URL(window.location.href);
  url.searchParams.delete('room');
  history.replaceState({}, '', url);
}

// ══════════════════════════════════════════════════════════════════════════════
//  EVENT LISTENERS
// ══════════════════════════════════════════════════════════════════════════════

// Vote click (delegated)
$('nominees-grid').addEventListener('click', e => {
  const card = e.target.closest('.nominee-card');
  if (!card || card.classList.contains('card-disabled') || hasVoted) return;
  castVote(card.dataset.pid);
});

// Join / create
$('btn-join').addEventListener('click', async () => {
  const name = $('input-name').value.trim();
  const code = $('input-room-code').value.trim();

  if (!name)              { showError('Please enter your name.'); return; }
  if (name.length > 20)   { showError('Name must be 20 characters or less.'); return; }
  if (code && code.length !== 6) { showError('Room code must be exactly 6 characters.'); return; }

  $('btn-join').disabled    = true;
  $('btn-join').textContent = 'Entering…';

  // 8-second timeout — catches Firestore not being enabled yet
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('timeout')), 8000)
  );

  try {
    await Promise.race([joinOrCreate(name, code), timeout]);
  } catch (err) {
    console.error('Join error:', err);
    if (err.message === 'timeout') {
      showError('Connection timed out. Make sure Firestore is enabled in your Firebase console.');
    } else {
      showError(`Error: ${err.message}`);
    }
  } finally {
    $('btn-join').disabled    = false;
    $('btn-join').textContent = 'Join Game';
  }
});

// Enter key on join inputs
['input-name', 'input-room-code'].forEach(id =>
  $(id).addEventListener('keydown', e => { if (e.key === 'Enter') $('btn-join').click(); })
);

// Auto-uppercase room code
$('input-room-code').addEventListener('input', function () {
  this.value = this.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});

// Build emoji grid
(function buildEmojiGrid() {
  $('emoji-grid').innerHTML = EMOJIS.map((e, i) =>
    `<button class="emoji-btn${i === 0 ? ' selected' : ''}" data-emoji="${e}" type="button">${e}</button>`
  ).join('');
})();

$('emoji-grid').addEventListener('click', e => {
  const btn = e.target.closest('.emoji-btn');
  if (!btn) return;
  myEmoji = btn.dataset.emoji;
  document.querySelectorAll('.emoji-btn').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
});

// Pre-populate room code from URL on load (e.g. ?room=ABC123)
const urlCode = getRoomCodeFromUrl();
if (urlCode) $('input-room-code').value = urlCode;

// Start game
$('btn-start').addEventListener('click', startGame);

// Play again
$('btn-play-again').addEventListener('click', () => {
  if (unsubscribeRoom) { unsubscribeRoom(); unsubscribeRoom = null; }
  clearTimers();
  roomCode = ''; lastRound = -1; hasVoted = false; advanceLocked = false;
  $('input-room-code').value = '';
  clearRoomCodeFromUrl();
  showScreen('screen-join');
});
