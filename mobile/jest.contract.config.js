// Contract tests: real local backend (docker `billarmobile`, http://localhost:8090), plain Node (no RN runtime).
// Picks up any `__contract__/**/*.test.ts` so every feature slice can add its own.
module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/**/__contract__/**/*.test.ts'],
  transform: { '^.+\.[jt]sx?$': ['babel-jest', { presets: ['babel-preset-expo'] }] },
  transformIgnorePatterns: ['node_modules/(?!(socket.io-client|engine.io-client|socket.io-parser|@socket.io)/)'],
  testTimeout: 30000,
  maxWorkers: 1,
};
