const positiveInteger = (value, fallback, minimum = 1) => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed >= minimum ? parsed : fallback;
};

export function loadConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const originSetting = env.CLIENT_ORIGIN ?? (production ? '' : 'http://localhost:5173');
  const configuredOrigins = originSetting
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean);

  if (production && configuredOrigins.length === 0) {
    throw new Error('CLIENT_ORIGIN must contain at least one trusted origin in production.');
  }

  return Object.freeze({
    nodeEnv: env.NODE_ENV || 'development',
    port: positiveInteger(env.PORT, 5000),
    clientOrigins: configuredOrigins,
    waitingRoomTtlMs: positiveInteger(env.WAITING_ROOM_TTL_MS, 10 * 60 * 1000, 1000),
    activeRoomIdleTtlMs: positiveInteger(env.ACTIVE_ROOM_IDLE_TTL_MS, 60 * 60 * 1000, 1000),
    disconnectGraceMs: positiveInteger(env.DISCONNECT_GRACE_MS, 45 * 1000, 1000),
    maxMessageLength: positiveInteger(env.MAX_MESSAGE_LENGTH, 2000, 1),
    messageRateLimit: positiveInteger(env.MESSAGE_RATE_LIMIT, 10, 1),
    messageRateWindowMs: positiveInteger(env.MESSAGE_RATE_WINDOW_MS, 5000, 100),
    roomActionRateLimit: positiveInteger(env.ROOM_ACTION_RATE_LIMIT, 20, 1),
    roomActionRateWindowMs: positiveInteger(env.ROOM_ACTION_RATE_WINDOW_MS, 60 * 1000, 100),
    maxRooms: positiveInteger(env.MAX_ROOMS, 1000, 1),
    serveClient: env.SERVE_CLIENT?.toLowerCase() !== 'false',
    maxHttpBufferSize: positiveInteger(env.MAX_HTTP_BUFFER_SIZE, 16 * 1024, 1024),
    heartbeatIntervalMs: positiveInteger(env.HEARTBEAT_INTERVAL_MS, 25 * 1000, 1000),
    heartbeatTimeoutMs: positiveInteger(env.HEARTBEAT_TIMEOUT_MS, 20 * 1000, 1000),
    maxConnections: positiveInteger(env.MAX_CONNECTIONS, 500),
    isProduction: production,
  });
}
