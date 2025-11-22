import WebSocket from 'ws';
(global as any).WebSocket = WebSocket;

process.on('uncaughtException', (error: Error) => {
  console.error('\n❌ UNCAUGHT EXCEPTION:', error.message);
  console.error('Stack:', error.stack);
  console.error('App will continue running...\n');
});

process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
  console.error('\n❌ UNHANDLED REJECTION:', reason);
  console.error('Promise:', promise);
  console.error('App will continue running...\n');
});
