import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { createRoomKey, isValidRoomKey } from '../crypto/chatCrypto.js';
import { emitWithAck, getSocket, sessionStorageKey } from '../services/socket.js';

const CODE_PATTERN = /^[A-HJ-NP-Z2-9]{6}$/;

function ensureConnected(socket) {
  if (socket.connected) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off('connect', onConnect);
      socket.off('connect_error', onError);
      reject(new Error('Could not connect to the chat server. Please try again.'));
    }, 10000);
    const onConnect = () => {
      clearTimeout(timeout);
      socket.off('connect_error', onError);
      resolve();
    };
    const onError = () => {
      clearTimeout(timeout);
      socket.off('connect', onConnect);
      reject(new Error('Could not connect to the chat server. Please check your connection.'));
    };
    socket.once('connect', onConnect);
    socket.once('connect_error', onError);
    socket.connect();
  });
}

export default function HomePage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [roomCode, setRoomCode] = useState('');
  const [inviteKey, setInviteKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState(location.state?.notice ?? '');

  async function createRoom() {
    setBusy(true);
    setError('');
    try {
      const key = createRoomKey();
      const socket = getSocket();
      await ensureConnected(socket);
      const response = await emitWithAck(socket, 'room:create', {});
      if (!response?.ok)
        throw new Error(response?.error?.message || 'A room could not be created.');
      const data = response.data;
      sessionStorage.setItem(sessionStorageKey(data.roomCode), data.sessionId);
      navigate(`/r/${data.roomCode}#${key}`);
    } catch (reason) {
      setError(reason?.message || 'A room could not be created. Please try again.');
      setBusy(false);
    }
  }

  function joinRoom(event) {
    event.preventDefault();
    setError('');
    setInfo('');
    const code = roomCode.trim().toUpperCase();
    const key = inviteKey.trim();
    if (!CODE_PATTERN.test(code)) {
      setError('Enter the 6-character room code from the invite.');
      return;
    }
    if (!isValidRoomKey(key)) {
      setError(
        'The encryption key is required. Use the full invite link, or paste the key after #.',
      );
      return;
    }
    navigate(`/r/${code}#${key}`);
  }

  return (
    <main className="page-shell home-shell">
      <header className="site-header">
        <a className="brand" href="/" aria-label="Ephemeral Chat home">
          <span className="brand-mark" aria-hidden="true">
            <span />
          </span>
          <span>
            ephemeral<span className="brand-dot">.</span>
          </span>
        </a>
        <div className="header-note">
          <span className="header-lock" aria-hidden="true">
            ⌑
          </span>{' '}
          No accounts. No history.
        </div>
      </header>

      <section className="hero-grid" aria-labelledby="hero-title">
        <div className="hero-copy">
          <div className="eyebrow">
            <span className="eyebrow-dot" /> A little room for two
          </div>
          <h1 id="hero-title">
            A conversation,
            <br />
            <em>then gone.</em>
          </h1>
          <p className="hero-intro">
            Private by design. Make a room, share the invite, say what you need to say. When you
            leave, the room disappears.
          </p>
          <div className="promise-list">
            <div className="promise-item">
              <span className="promise-icon lock-icon" aria-hidden="true">
                ⌑
              </span>
              <span>
                <strong>End-to-end encrypted</strong>
                <small>Only your browsers hold the key.</small>
              </span>
            </div>
            <div className="promise-item">
              <span className="promise-icon vanish-icon" aria-hidden="true">
                ↗
              </span>
              <span>
                <strong>Here for the moment</strong>
                <small>No database. No conversation history.</small>
              </span>
            </div>
          </div>
        </div>

        <div className="entry-card">
          <div className="card-topline">
            <span className="live-mark" />
            <span>YOUR PRIVATE ROOM</span>
            <span className="card-topline-end">01 / 02</span>
          </div>
          <h2>Start a conversation</h2>
          <p className="card-description">
            A room for you and one other person. Nothing to sign up for.
          </p>
          <button
            className="button button-primary create-button"
            type="button"
            onClick={createRoom}
            disabled={busy}
          >
            <span>{busy ? 'Creating your room…' : 'Create a room'}</span>
            <span className="button-arrow" aria-hidden="true">
              ↗
            </span>
          </button>
          <div className="or-divider">
            <span /> <span>OR JOIN WITH AN INVITE</span> <span />
          </div>
          <form onSubmit={joinRoom} className="join-form">
            <label htmlFor="room-code">Room code</label>
            <input
              id="room-code"
              name="roomCode"
              autoComplete="off"
              maxLength={6}
              value={roomCode}
              onChange={(event) => setRoomCode(event.target.value.toUpperCase())}
              placeholder="e.g. 8XK29P"
              aria-describedby="join-help"
            />
            <label htmlFor="invite-key" className="key-label">
              Invite key <span>(from the link after #)</span>
            </label>
            <input
              id="invite-key"
              name="inviteKey"
              type="password"
              autoComplete="off"
              value={inviteKey}
              onChange={(event) => setInviteKey(event.target.value)}
              placeholder="Paste only if joining by code"
              aria-describedby="join-help"
            />
            <p id="join-help" className="field-help">
              Opening the full invite link fills this in automatically. The key stays in your
              browser.
            </p>
            {error && (
              <p className="form-message form-error" role="alert">
                {error}
              </p>
            )}
            {info && (
              <p className="form-message form-info" role="status">
                {info}
              </p>
            )}
            <button className="button button-secondary join-button" type="submit" disabled={busy}>
              Join room <span aria-hidden="true">→</span>
            </button>
          </form>
          <div className="card-footnote">
            <span aria-hidden="true">✳</span> Two people max <i /> Messages vanish when the room
            ends
          </div>
        </div>
      </section>

      <section className="how-strip" aria-label="How it works">
        <div>
          <span className="step-number">01</span>
          <span>
            <strong>Create</strong>
            <small>One tap, one private room.</small>
          </span>
        </div>
        <span className="step-connector" aria-hidden="true">
          ⟶
        </span>
        <div>
          <span className="step-number">02</span>
          <span>
            <strong>Invite</strong>
            <small>Share the link with one person.</small>
          </span>
        </div>
        <span className="step-connector" aria-hidden="true">
          ⟶
        </span>
        <div>
          <span className="step-number">03</span>
          <span>
            <strong>Let go</strong>
            <small>End the chat. It is discarded.</small>
          </span>
        </div>
      </section>

      <footer className="site-footer">
        <span>Built for conversations that do not need to stay.</span>
        <span>Messages are not persisted by this application.</span>
      </footer>
    </main>
  );
}
