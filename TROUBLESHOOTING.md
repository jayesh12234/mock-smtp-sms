# Mock SMTP Service - Troubleshooting & Fixes

## Problem
Mock SMTP UI is not loading in Rancher across all environments for the last 3-4 days.

## Root Causes Identified

### 1. ⚠️ **CRITICAL: Outdated Node.js Version**
- **Previous**: `node:16` (EOL: September 11, 2023)
- **Issue**: Security vulnerabilities, dependency incompatibilities, performance issues
- **Fix**: Upgraded to `node:20-alpine` (LTS, actively maintained)

### 2. ⚠️ **WebSocket Mixed Content Error (HTTPS → WS)**
- **Issue**: When Rancher UI loads via HTTPS but tries to connect to WS (not WSS), browsers block the connection
- **Symptom**: "Connection Status: disconnected" persists
- **Fix**: Updated WebSocket URL builder to automatically use WSS for HTTPS pages

### 3. **Dockerfile Inefficiency**
- **Previous Issue**:
  ```dockerfile
  RUN npm install       # Installs all deps (dev + prod)
  RUN npm ci --only=production  # Removes dev dependencies
  ```
- **Fix**: Consolidated to single `npm ci --only=production` step
- **Benefit**: Smaller Docker image, faster builds, clearer intent

### 4. **Package Conflict**
- **Previous**: Both `ws` (8.8.1) and `websocket` (1.0.34) in dependencies
- **Issue**: Unnecessary duplication, potential conflicts
- **Fix**: Kept only `ws@^8.14.0` (latest stable)
- **Note**: Moved `nodemon` to devDependencies

## Changes Made

### File: `smtp/Dockerfile`
```diff
- FROM node:16
+ FROM node:20-alpine

- COPY . ./
- RUN npm install
- RUN npm ci --only=production
+ COPY package*.json ./
+ RUN npm ci --only=production
+ COPY app.js index.html ./
```

### File: `smtp/package.json`
- Removed: `websocket@1.0.34` (conflicting library)
- Updated: `ws` to `^8.14.0`
- Moved: `nodemon` to `devDependencies`

### File: `smtp/index.html`
- **Fixed WebSocket URL builder** to automatically determine WSS vs WS based on page protocol
- Ensures HTTPS pages connect via WSS
- Ensures HTTP pages connect via WS

## Deployment Steps

1. **Rebuild Docker image**:
   ```bash
   cd smtp
   npm ci
   docker build -t mosipqa/mock-smtp:latest .
   ```

2. **Update Helm deployment** (if using registry):
   ```bash
   helm upgrade mock-smtp ./helm/mock-smtp/ -n <namespace>
   ```

3. **Verify deployment**:
   - Check pod status: `kubectl get pods -n <namespace>`
   - Check logs: `kubectl logs -f <pod-name> -n <namespace>`
   - Visit UI: Should show "Connection Status: connected"

## Health Checks
The service exposes:
- `GET /health` → Simple health check (always 200)
- `GET /ready` → Readiness probe (503 if starting, 200 when ready)
- `GET /` → UI interface
- `GET /messages` → Message API
- WebSocket connection on configured port

## Verification Checklist

- [ ] Docker image builds successfully
- [ ] Pod starts and stays running
- [ ] Health endpoint responds (200 OK)
- [ ] Ready endpoint returns ready status
- [ ] UI loads without console errors
- [ ] WebSocket shows "Connection Status: connected"
- [ ] Emails/SMS appear in the UI

## Additional Notes

- **Node 20-alpine**: Smaller image size, better security, actively maintained
- **Alpine Linux**: Reduces image footprint and attack surface
- **WebSocket fix**: Critical for HTTPS deployments (like Rancher)
- All three ports still exposed: 8080 (HTTP), 8081 (WebSocket), 8025 (SMTP)

## Rollback (if needed)
If issues occur, revert to previous version:
```bash
git revert HEAD
docker build -t mosipqa/mock-smtp:previous .
helm upgrade mock-smtp ./helm/mock-smtp/ --set image.tag=previous
```
