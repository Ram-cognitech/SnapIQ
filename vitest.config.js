import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
    // These tests cross a network and wait on a server-sent event stream, so the
    // default five seconds is too tight to tell a slow reply from a broken one.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // One request at a time: several of these assert on "the most recent live
    // channel", which is meaningless if tests race each other.
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
