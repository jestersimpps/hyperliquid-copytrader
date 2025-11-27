module.exports = {
  apps: [
    {
      name: 'hyperscalper',
      script: 'node_modules/.bin/tsx',
      args: 'src/index.ts',
      cwd: '.',
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production'
      },
      error_file: './logs/error.log',
      out_file: './logs/out.log',
      time: true,
      restart_delay: 5000,
      kill_timeout: 10000
    },
    {
      name: 'hyperscalper-dashboard',
      script: 'node_modules/.bin/tsx',
      args: 'src/api/server.ts',
      cwd: '.',
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '200M',
      env: {
        NODE_ENV: 'production'
      },
      error_file: './logs/dashboard-error.log',
      out_file: './logs/dashboard-out.log',
      time: true,
      restart_delay: 5000
    }
  ]
}
