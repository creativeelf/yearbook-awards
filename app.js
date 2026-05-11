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
const MAX_PLAYERS = 10;
const ROUNDS      = 10;

const ALL_QUESTIONS = [
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
  "Most likely to start a cult with genuinely excellent merch",
  "Most likely to convince you of absolutely anything",
  "Most likely to show up 2 hours early and still somehow be late",
  "Most likely to own a secret island",
  "Most likely to be mistaken for a celebrity in another country",
  "Most likely to become a licensed nap consultant",
  "Most likely to know a guy who knows every guy",
  "Most likely to accidentally discover a new species",
];

// ── Session state ─────────────────────────────────────────────────────────────
let myId            = null;
let myName          = '';
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
        [myId]: { name, score: 0, awards: [] },
      },
    });
  } else {
    const snap = await getDoc(ref);
    if (!snap.exists())                                    { showError('Room not found. Check the code.'); return; }
    if (snap.data().state !== 'lobby')                    { showError('That game has already started.'); return; }
    if (Object.keys(snap.data().players).length >= MAX_PLAYERS) { showError('Room is full (10 players max).'); return; }

    await updateDoc(ref, {
      [`players.${myId}`]: { name, score: 0, awards: [] },
    });
  }

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

  $('lobby-players-grid').innerHTML = pids.map(pid => `
    <div class="hextech-panel p-3 text-center relative"
         style="clip-path:polygon(8px 0%,calc(100% - 8px) 0%,100% 8px,100% calc(100% - 8px),calc(100% - 8px) 100%,8px 100%,0% calc(100% - 8px),0% 8px);">
      <div class="text-sm font-semibold truncate">${esc(players[pid].name)}</div>
      ${pid === data.host ? `<div class="text-xs mt-0.5" style="color:#c89b3c;font-size:0.6rem;letter-spacing:.1em;">HOST</div>` : ''}
      ${pid === myId    ? `<div class="text-xs mt-0.5" style="color:#0ac8b9;font-size:0.6rem;">(you)</div>` : ''}
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
          <div class="font-semibold text-sm sm:text-base truncate mb-1">${esc(players[pid].name)}</div>
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

    $('r-winner-name').textContent = result.winnerName ?? '';

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
  const sorted  = Object.entries(players).sort(([, a], [, b]) => b.score - a.score);

  const rankRoman  = ['I', 'II', 'III'];
  const rankClass  = ['rank-1', 'rank-2', 'rank-3'];

  $('leaderboard-list').innerHTML = sorted.map(([pid, p], idx) => {
    const rank    = idx + 1;
    const rClass  = rank <= 3 ? rankClass[idx] : 'rank-other';
    const rLabel  = rank <= 3 ? rankRoman[idx] : rank;
    const isMe    = pid === myId;
    const delay   = idx * 0.08;

    const awardsHtml = (p.awards ?? []).length
      ? `<div class="flex flex-wrap gap-1 mt-2">
           ${p.awards.map(a => `
             <span class="px-2 py-0.5 text-xs"
                   style="border:1px solid #c89b3c33;color:#c89b3c77;font-size:0.6rem;">
               ${esc(a.length > 45 ? a.slice(0, 45) + '…' : a)}
             </span>`).join('')}
         </div>`
      : '';

    return `
      <div class="rank-row ${rClass} anim-fade-in-up" style="animation-delay:${delay}s;">
        <div class="hextech-panel p-4 relative ${isMe ? '' : ''}">
          <div class="corner corner-tl"></div>
          <div class="corner corner-tr"></div>
          <div class="corner corner-bl"></div>
          <div class="corner corner-br"></div>
          ${isMe ? `<div style="position:absolute;inset:0;background:rgba(10,200,185,0.04);pointer-events:none;"></div>` : ''}
          <div class="flex items-center gap-3">
            <div class="rank-badge">${rLabel}</div>
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2">
                <span class="font-semibold truncate">${esc(p.name)}${isMe ? ' <span style="color:#0ac8b9;font-size:0.7rem;">(you)</span>' : ''}</span>
                <span class="ml-auto flex-shrink-0 font-bold text-sm" style="color:#c89b3c;">${p.score} Gold</span>
              </div>
              ${awardsHtml}
            </div>
          </div>
        </div>
      </div>`;
  }).join('');
}

// ── Mastery burst (unanimous win) ─────────────────────────────────────────────
function triggerMasteryBurst() {
  const overlay = $('mastery-overlay');
  overlay.classList.remove('hidden');
  setTimeout(() => overlay.classList.add('hidden'), 2200);
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

// Start game
$('btn-start').addEventListener('click', startGame);

// Play again
$('btn-play-again').addEventListener('click', () => {
  if (unsubscribeRoom) { unsubscribeRoom(); unsubscribeRoom = null; }
  clearTimers();
  roomCode = ''; lastRound = -1; hasVoted = false; advanceLocked = false;
  $('input-room-code').value = '';
  showScreen('screen-join');
});
