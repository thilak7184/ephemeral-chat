import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  decryptMessage,
  encryptMessage,
  importRoomKey,
  isValidRoomKey,
} from '../crypto/chatCrypto.js';
import { emitWithAck, getSocket, sessionStorageKey } from '../services/socket.js';

const MAX_MESSAGE_LENGTH = Number(import.meta.env.VITE_MAX_MESSAGE_LENGTH || 2000);
const ERROR_TEXT = {
  INVALID_ROOM_CODE: 'That room code is not valid.',
  ROOM_NOT_FOUND: 'This room no longer exists.',
  ROOM_EXPIRED: 'This room has expired.',
  ROOM_FULL: 'This room is already full. Only two people can participate.',
  INVALID_SESSION: 'This session could not be restored. Open the original invite link again.',
  SESSION_IN_USE:
    'Your previous connection is still closing. Try opening the invite again in a moment.',
  NOT_IN_ROOM: 'You are no longer a participant in this room.',
  RATE_LIMITED: 'You are sending messages too quickly. Please wait a moment.',
  MESSAGE_TOO_LONG: 'That message is too long.',
};

function timeLabel(timestamp) {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(
    new Date(timestamp),
  );
}

function appendSystem(setMessages, text) {
  setMessages((current) => [
    ...current,
    { id: crypto.randomUUID(), kind: 'system', text, timestamp: Date.now() },
  ]);
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const input = document.createElement('textarea');
  input.value = text;
  input.setAttribute('readonly', '');
  input.style.position = 'fixed';
  input.style.opacity = '0';
  document.body.appendChild(input);
  input.select();
  const copied = document.execCommand('copy');
  input.remove();
  if (!copied) throw new Error('Copy was not available in this browser.');
}

export default function RoomPage() {
  const { roomCode: rawRoomCode = '' } = useParams();
  const roomCode = rawRoomCode.toUpperCase();
  const navigate = useNavigate();
  const [fragmentKey, setFragmentKey] = useState(() => window.location.hash.slice(1));
  const [keyEntry, setKeyEntry] = useState('');
  const [cryptoKey, setCryptoKey] = useState(null);
  const [keyError, setKeyError] = useState('');
  const [connection, setConnection] = useState('connecting');
  const [roomInfo, setRoomInfo] = useState(null);
  const [failure, setFailure] = useState(null);
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [typing, setTyping] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copyState, setCopyState] = useState('Copy invite link');
  const [notice, setNotice] = useState('');
  const socketRef = useRef(null);
  const listRef = useRef(null);
  const typingTimer = useRef(null);
  const joinedOnce = useRef(false);
  const leaveTimer = useRef(null);

  useEffect(() => {
    let cancelled = false;
    setCryptoKey(null);
    if (!fragmentKey) {
      setKeyError(
        'This invite is missing its encryption key. Use the full invite link, or paste the key below.',
      );
      return undefined;
    }
    importRoomKey(fragmentKey)
      .then((key) => {
        if (!cancelled) {
          setCryptoKey(key);
          setKeyError('');
        }
      })
      .catch((error) => {
        if (!cancelled) setKeyError(error.message);
      });
    return () => {
      cancelled = true;
    };
  }, [fragmentKey]);

  const finishRoom = useCallback(
    (message) => {
      setMessages([]);
      setCryptoKey(null);
      sessionStorage.removeItem(sessionStorageKey(roomCode));
      window.history.replaceState(null, '', window.location.pathname);
      navigate('/', {
        replace: true,
        state: {
          notice:
            message || 'This chat has ended. Nothing from this room was saved by the application.',
        },
      });
    },
    [navigate, roomCode],
  );

  useEffect(() => {
    if (!cryptoKey || failure) return undefined;
    if (leaveTimer.current) {
      clearTimeout(leaveTimer.current);
      leaveTimer.current = null;
    }
    const socket = getSocket();
    socketRef.current = socket;
    let joinPending = false;
    let disposed = false;
    let retryTimer = null;
    let sessionConflictDeadline = null;

    const scheduleJoinRetry = (delayMs) => {
      if (disposed) return;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = setTimeout(() => {
        retryTimer = null;
        join();
      }, delayMs);
    };

    const join = async () => {
      if (joinPending || disposed || !socket.connected) return;
      joinPending = true;
      setConnection('connecting');
      const savedSession = sessionStorage.getItem(sessionStorageKey(roomCode));
      try {
        const response = await emitWithAck(socket, 'room:join', {
          roomCode,
          sessionId: savedSession || undefined,
        });
        if (disposed) return;
        if (!response?.ok) {
          const code = response?.error?.code || 'SERVER_ERROR';
          if (code === 'SESSION_IN_USE') {
            sessionConflictDeadline ??= Date.now() + 48_000;
            if (Date.now() < sessionConflictDeadline) {
              setConnection('reconnecting');
              setNotice('Restoring your seat…');
              scheduleJoinRetry(3000);
              return;
            }
          }
          if (
            code === 'INVALID_SESSION' &&
            sessionConflictDeadline &&
            Date.now() < sessionConflictDeadline
          ) {
            sessionStorage.removeItem(sessionStorageKey(roomCode));
            sessionConflictDeadline = null;
            scheduleJoinRetry(300);
            return;
          }
          if (code === 'INVALID_SESSION') sessionStorage.removeItem(sessionStorageKey(roomCode));
          setFailure({
            code,
            message:
              ERROR_TEXT[code] || response?.error?.message || 'The room could not be joined.',
          });
          setConnection('disconnected');
          return;
        }
        const data = response.data;
        sessionConflictDeadline = null;
        setNotice('');
        sessionStorage.setItem(sessionStorageKey(roomCode), data.sessionId);
        setRoomInfo(data);
        setConnection('connected');
        if (data.reconnected || joinedOnce.current)
          appendSystem(setMessages, 'Connection restored.');
        joinedOnce.current = true;
      } catch (error) {
        if (!disposed) {
          setConnection('reconnecting');
          setNotice(error.message || 'Trying to reconnect…');
          if (socket.connected) scheduleJoinRetry(3000);
        }
      } finally {
        joinPending = false;
      }
    };

    const onConnect = () => {
      setConnection('connected');
      join();
    };
    const onDisconnect = () => {
      setConnection('reconnecting');
      if (joinedOnce.current) appendSystem(setMessages, 'Connection lost. Trying to reconnect…');
    };
    const onConnectError = () => setConnection('reconnecting');
    const onMessage = async (packet) => {
      try {
        const plaintext = await decryptMessage(cryptoKey, packet);
        setMessages((current) => [
          ...current,
          {
            id: crypto.randomUUID(),
            kind: 'chat',
            mine: Boolean(packet.mine),
            text: plaintext,
            timestamp: packet.sentAt || Date.now(),
          },
        ]);
      } catch {
        setNotice(
          'A message could not be decrypted. Make sure both people used the same invite link.',
        );
      }
    };
    const onParticipantJoined = (event) => {
      setRoomInfo((current) =>
        current
          ? {
              ...current,
              state: 'ACTIVE',
              participantCount: Math.min(2, current.participantCount + 1),
            }
          : current,
      );
      appendSystem(setMessages, event?.message || 'Someone joined the room.');
    };
    const onParticipantLeft = (event) => {
      setRoomInfo((current) =>
        current ? { ...current, state: 'WAITING', participantCount: 1 } : current,
      );
      appendSystem(setMessages, event?.message || 'Someone left the room.');
    };
    const onParticipantConnection = (event) =>
      appendSystem(
        setMessages,
        event?.message || (event?.connected ? 'Connection restored.' : 'Someone lost connection.'),
      );
    const onTyping = (event) => setTyping(Boolean(event?.typing));
    const onEnded = (event) => finishRoom(event?.message);
    const onExpired = () => {
      sessionStorage.removeItem(sessionStorageKey(roomCode));
      setMessages([]);
      setFailure({ code: 'ROOM_EXPIRED', message: 'This room no longer exists.' });
      setRoomInfo(null);
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('connect_error', onConnectError);
    socket.on('message:receive', onMessage);
    socket.on('participant:joined', onParticipantJoined);
    socket.on('participant:left', onParticipantLeft);
    socket.on('participant:connection', onParticipantConnection);
    socket.on('typing:update', onTyping);
    socket.on('room:ended', onEnded);
    socket.on('room:expired', onExpired);
    if (socket.connected) onConnect();
    else socket.connect();

    return () => {
      disposed = true;
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('connect_error', onConnectError);
      socket.off('message:receive', onMessage);
      socket.off('participant:joined', onParticipantJoined);
      socket.off('participant:left', onParticipantLeft);
      socket.off('participant:connection', onParticipantConnection);
      socket.off('typing:update', onTyping);
      socket.off('room:ended', onEnded);
      socket.off('room:expired', onExpired);
      if (typingTimer.current) clearTimeout(typingTimer.current);
      if (retryTimer) clearTimeout(retryTimer);
      leaveTimer.current = setTimeout(() => {
        if (socket.connected) socket.emit('room:leave', {});
        leaveTimer.current = null;
      }, 400);
      socketRef.current = null;
    };
  }, [cryptoKey, failure, finishRoom, roomCode]);

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages, typing]);

  function acceptKey(event) {
    event.preventDefault();
    const key = keyEntry.trim();
    if (!isValidRoomKey(key)) {
      setKeyError('That key is not valid. Paste the part after # from the original invite link.');
      return;
    }
    window.history.replaceState(null, '', `${window.location.pathname}#${key}`);
    setFragmentKey(key);
    setKeyEntry('');
  }

  function handleDraftChange(event) {
    const value = event.target.value;
    setDraft(value);
    if (!socketRef.current || !roomInfo || roomInfo.state !== 'ACTIVE') return;
    socketRef.current.emit(value ? 'typing:start' : 'typing:stop');
    if (typingTimer.current) clearTimeout(typingTimer.current);
    if (value) typingTimer.current = setTimeout(() => socketRef.current?.emit('typing:stop'), 850);
  }

  async function sendMessage() {
    const text = draft.trim();
    if (!text || busy || !cryptoKey) return;
    if (text.length > MAX_MESSAGE_LENGTH) {
      setNotice(`Keep messages to ${MAX_MESSAGE_LENGTH.toLocaleString()} characters or fewer.`);
      return;
    }
    setBusy(true);
    setNotice('');
    try {
      const packet = await encryptMessage(cryptoKey, text);
      const response = await emitWithAck(socketRef.current, 'message:send', packet);
      if (!response?.ok)
        throw new Error(
          response?.error?.message ||
            ERROR_TEXT[response?.error?.code] ||
            'Message could not be sent.',
        );
      setDraft('');
      socketRef.current.emit('typing:stop');
    } catch (error) {
      setNotice(error.message || 'Message could not be sent.');
    } finally {
      setBusy(false);
    }
  }

  function onComposerKeyDown(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  }

  async function copyInvite() {
    try {
      await copyText(window.location.href);
      setCopyState('Copied!');
      setTimeout(() => setCopyState('Copy invite link'), 1800);
    } catch (error) {
      setNotice(error.message);
    }
  }

  async function endChat() {
    if (
      !window.confirm('End this chat for both people? The room and its messages will be discarded.')
    )
      return;
    setBusy(true);
    try {
      const response = await emitWithAck(socketRef.current, 'room:end', {});
      if (!response?.ok)
        throw new Error(response?.error?.message || 'This chat could not be ended.');
      finishRoom('This chat has ended. Nothing from this room was saved by the application.');
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusy(false);
    }
  }

  if (keyError || !cryptoKey) {
    return (
      <main className="room-page key-page">
        <header className="room-header">
          <Link className="brand" to="/">
            <span className="brand-mark" aria-hidden="true">
              <span />
            </span>
            <span>
              ephemeral<span className="brand-dot">.</span>
            </span>
          </Link>
        </header>
        <section className="state-card key-card">
          <div className="state-icon state-icon-lock" aria-hidden="true">
            ⌑
          </div>
          <p className="eyebrow">ROOM {roomCode}</p>
          <h1>One last thing.</h1>
          <p>
            {keyError ||
              'The encryption key stays in the invite link fragment and never reaches the server.'}
          </p>
          <form className="key-form" onSubmit={acceptKey}>
            <label htmlFor="room-secret">Invite key</label>
            <input
              id="room-secret"
              type="password"
              autoComplete="off"
              value={keyEntry}
              onChange={(event) => setKeyEntry(event.target.value)}
              placeholder="Paste the value after #"
            />
            <button className="button button-primary" type="submit">
              Unlock room <span aria-hidden="true">→</span>
            </button>
          </form>
          <Link className="text-link" to="/">
            Back to home
          </Link>
        </section>
      </main>
    );
  }

  if (failure) {
    const isFull = failure.code === 'ROOM_FULL';
    const isExpired = ['ROOM_NOT_FOUND', 'ROOM_EXPIRED', 'INVALID_ROOM_CODE'].includes(
      failure.code,
    );
    return (
      <main className="room-page state-page">
        <header className="room-header">
          <Link className="brand" to="/">
            <span className="brand-mark" aria-hidden="true">
              <span />
            </span>
            <span>
              ephemeral<span className="brand-dot">.</span>
            </span>
          </Link>
        </header>
        <section className="state-card">
          <div className={`state-icon ${isFull ? 'state-icon-full' : ''}`} aria-hidden="true">
            {isFull ? '02' : '↗'}
          </div>
          <p className="eyebrow">ROOM {roomCode}</p>
          <h1>
            {isFull ? 'This room is full.' : isExpired ? 'This room is gone.' : 'Could not join.'}
          </h1>
          <p>{failure.message}</p>
          {isFull && (
            <p className="state-subtext">
              Only two people can participate in a room. Ask for a new invite if you think you
              should be here.
            </p>
          )}
          <Link className="button button-primary state-action" to="/">
            Create a new room <span aria-hidden="true">↗</span>
          </Link>
          {isExpired && (
            <p className="privacy-note">Rooms are temporary and cannot be reused after they end.</p>
          )}
        </section>
      </main>
    );
  }

  const statusLabel =
    connection === 'connected'
      ? 'Connected'
      : connection === 'connecting'
        ? 'Connecting'
        : 'Reconnecting';
  const isWaiting = !roomInfo || roomInfo.state === 'WAITING';

  return (
    <main className="room-page chat-page">
      <header className="room-header">
        <Link className="brand" to="/" aria-label="Ephemeral home">
          <span className="brand-mark" aria-hidden="true">
            <span />
          </span>
          <span>
            ephemeral<span className="brand-dot">.</span>
          </span>
        </Link>
        <div className={`connection-badge connection-${connection}`}>
          <span className="connection-dot" />
          {statusLabel}
        </div>
      </header>
      <section className="chat-frame" aria-label={`Temporary chat room ${roomCode}`}>
        <div className="chat-topbar">
          <div className="chat-room-title">
            <div className="secure-icon" aria-hidden="true">
              ⌑
            </div>
            <div>
              <p className="eyebrow">ENCRYPTED SPACE</p>
              <h1>
                Room <span>{roomCode}</span>
              </h1>
            </div>
          </div>
          <div className="topbar-actions">
            <span className="participant-count">
              <span className="participant-dot" />
              {roomInfo?.participantCount === 2 ? '2 / 2 here' : '1 / 2 here'}
            </span>
            <button className="end-button" type="button" onClick={endChat} disabled={busy}>
              End chat <span aria-hidden="true">×</span>
            </button>
          </div>
        </div>

        {isWaiting && (
          <div className="waiting-banner">
            <span className="waiting-orbit" aria-hidden="true">
              <i />
            </span>
            <div>
              <strong>Waiting for your person</strong>
              <span>Share this encrypted invite. The key never leaves your browser.</span>
            </div>
            <button className="copy-button" type="button" onClick={copyInvite}>
              <span aria-hidden="true">▣</span> {copyState}
            </button>
          </div>
        )}

        <div className="message-list" ref={listRef} aria-live="polite" aria-label="Chat messages">
          {messages.length === 0 && (
            <div className="empty-chat">
              <div className="empty-chat-symbol" aria-hidden="true">
                ✳
              </div>
              <h2>{isWaiting ? 'A quiet room, for now.' : 'You’re connected.'}</h2>
              <p>
                {isWaiting
                  ? 'When the other person joins, your conversation can begin.'
                  : 'Messages are encrypted in your browser before they are sent.'}
              </p>
              <span className="empty-chat-lock">
                <span aria-hidden="true">⌑</span> End-to-end encrypted
              </span>
            </div>
          )}
          {messages.map((message) =>
            message.kind === 'system' ? (
              <div className="system-message" key={message.id}>
                <span />
                {message.text}
                <span />
              </div>
            ) : (
              <article
                className={`message-row ${message.mine ? 'message-mine' : 'message-theirs'}`}
                key={message.id}
              >
                <div className="message-bubble">
                  <p>{message.text}</p>
                  <time dateTime={new Date(message.timestamp).toISOString()}>
                    {timeLabel(message.timestamp)}
                  </time>
                </div>
              </article>
            ),
          )}
          {typing && (
            <div className="typing-indicator" aria-label="The other person is typing">
              <span />
              <span />
              <span />
              <small>typing</small>
            </div>
          )}
        </div>

        <div className="composer-wrap">
          {notice && (
            <p className="inline-notice" role="status">
              {notice}
              <button type="button" aria-label="Dismiss message" onClick={() => setNotice('')}>
                ×
              </button>
            </p>
          )}
          <div className="composer">
            <label className="sr-only" htmlFor="chat-message">
              Type an encrypted message
            </label>
            <textarea
              id="chat-message"
              value={draft}
              onChange={handleDraftChange}
              onKeyDown={onComposerKeyDown}
              onBlur={() => socketRef.current?.emit('typing:stop')}
              maxLength={MAX_MESSAGE_LENGTH + 1}
              placeholder={
                isWaiting ? 'Say hello when they arrive…' : 'Write something that stays here…'
              }
              rows={1}
            />
            <button
              className="send-button"
              type="button"
              onClick={sendMessage}
              disabled={!draft.trim() || busy || connection !== 'connected'}
              aria-label="Send message"
            >
              <span aria-hidden="true">↑</span>
            </button>
          </div>
          <div className="composer-meta">
            <span>
              Enter to send <i /> Shift + Enter for a new line
            </span>
            <span>
              {draft.length}/{MAX_MESSAGE_LENGTH}
            </span>
          </div>
        </div>
      </section>
      <footer className="room-footer">
        <span>
          <span aria-hidden="true">⌑</span> Your messages are encrypted before they leave this
          device.
        </span>
        <span>Not saved by the application</span>
      </footer>
    </main>
  );
}
