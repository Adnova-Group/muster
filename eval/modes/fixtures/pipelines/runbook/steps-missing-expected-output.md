1. `kubectl get pods -n payments -l app=reconciler` -> expected: all pods Running, 0 restarts
2. `curl -s https://internal/health/reconciler`
