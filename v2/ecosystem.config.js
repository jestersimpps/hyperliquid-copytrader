module.exports = {
  apps: [
    {
      name: 'hyperscalper',
      script: 'npm',
      args: 'start',
      cwd: '.',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production'
      },
      time: true,
      restart_delay: 5000,
      kill_timeout: 10000
    },
    {
      name: 'hyperscalper-dashboard',
      script: 'npm',
      args: 'run dashboard',
      cwd: '.',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '200M',
      env: {
        NODE_ENV: 'production',
        PORT: 3000
      },
      time: true,
      restart_delay: 5000
    }
  ]
}
