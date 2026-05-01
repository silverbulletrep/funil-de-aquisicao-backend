/**
 * local server entry file, for local development
 */
import dotenv from 'dotenv'
import app from './app.js';
import { startRecoveryScheduler } from './lib/recoveryScheduler.js'

dotenv.config()

/**
 * start server with port
 */
const PORT = process.env.PORT || 3005;
const recoveryScheduler = startRecoveryScheduler()

const server = app.listen(PORT, () => {
  console.log(`Server ready on port ${PORT}`);
});

/**
 * close server
 */
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received');
  recoveryScheduler.stop()
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT signal received');
  recoveryScheduler.stop()
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

export default app;
