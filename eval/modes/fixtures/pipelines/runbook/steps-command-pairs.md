1. `kubectl get pods -n payments -l app=reconciler` -> expected: all pods Running, 0 restarts
2. `curl -s https://internal/health/reconciler` -> expected: HTTP 200, body {"status":"ok"}
3. `kubectl logs -n payments deploy/reconciler --tail=50` -> expected: no ERROR lines in the last 50
