# WebContainer Host

Production-ready WebContainer host for AI coding platforms.

## Features

- 🚀 **High Performance** - Optimized boot time and resource usage
- 🔒 **Secure** - Origin validation and CSP headers
- 🛡️ **Resilient** - Comprehensive error handling and recovery
- 📡 **Real-time** - Live preview and console output streaming
- 🎯 **Production Ready** - Battle-tested patterns and monitoring

## Setup

1. Clone this repository
2. Install dependencies:
   ```bash
   npm install

Run locally:
bashnpm run dev

Deploy to Vercel:
bashvercel --prod


Integration
Add your domain to the ALLOWED_ORIGINS array in main.js:
javascriptconst ALLOWED_ORIGINS = [
  'https://your-domain.com',
  'https://lovable.dev'
];
Message Protocol
Incoming Messages

ping - Health check
mount_files - Mount file system
run_command - Execute command
write_file - Write single file
read_file - Read file content

Outgoing Messages

ready - WebContainer initialized
server_ready - Dev server running
command_output - Console output
error - Error occurred

Security

CORS headers configured
Origin validation
CSP policies enforced
XSS protection

License
MIT

### **8. Deploy Script (.github/workflows/deploy.yml)**
```yaml
name: Deploy to Vercel

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: 18
      - run: npm ci
      - run: npm run build
      - uses: amondnet/vercel-action@v25
        with:
          vercel-token: ${{ secrets.VERCEL_TOKEN }}
          vercel-org-id: ${{ secrets.VERCEL_ORG_ID }}
          vercel-project-id: ${{ secrets.VERCEL_PROJECT_ID }}
          vercel-args: '--prod'
