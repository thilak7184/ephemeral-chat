import { io } from 'socket.io-client';

let sharedSocket;

export function getSocket() {
  if (!sharedSocket) {
    sharedSocket = io(import.meta.env.VITE_SERVER_URL || undefined, {
      path: '/socket.io',
      autoConnect: false,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 500,
      reconnectionDelayMax: 5000,
      timeout: 10000,
    });
  }
  return sharedSocket;
}

export function sessionStorageKey(roomCode) {
  return `ephemeral-chat:session:${roomCode}`;
}

export function emitWithAck(socket, event, payload, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('The server did not respond in time.')),
      timeoutMs,
    );
    socket.emit(event, payload, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}
