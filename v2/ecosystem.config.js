module.exports = {
  apps: [
    {
      name: 'copyscalper-v2',
      script: 'npm',
      args: 'start',
      cwd: '.',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
        PORT: 3000
      },
      error_file: './logs/error.log',
      out_file: './logs/out.log',
      log_file: './logs/combined.log',
      time: true,
      restart_delay: 5000,
      kill_timeout: 10000,
      wait_ready: true,
      listen_timeout: 30000
    }
  ]
}
