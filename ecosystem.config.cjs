module.exports = {
  apps: [
    {
      name: "steward-bot",
      script: "dist/index.js",
      interpreter: "node",
      cwd: "C:\\Users\\Taru\\Documents\\Bot",
      autorestart: true,
      // Exit code 0 = intentional shutdown (don't restart). Everything else (crashes, code 75) = restart.
      stop_exit_codes: [0],
      max_restarts: 20,
      min_uptime: "5s",
      restart_delay: 2000,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      out_file: "logs/pm2-out.log",
      error_file: "logs/pm2-error.log",
      merge_logs: true,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
