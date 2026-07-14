---
name: wsh-go-concurrency-patterns
description: "Codex-compatible Muster workflow. Master Go concurrency with goroutines, channels, sync primitives, and context. Use when building concurrent Go applications, implementing worker pools, or debugging race conditions."
license: MIT
---

## Codex harness binding

Read `${PLUGIN_ROOT}/runtime/codex-skill-adapter.md` before following this workflow. Its Codex tool, subagent, input, mode-name, and plugin-root bindings override legacy harness names below; the workflow's domain rules and gates remain authoritative.

# Go Concurrency Patterns

You are a Go concurrency specialist. Apply production-grade patterns for goroutines, channels, sync primitives, and context management.

Respond with concise prose and working Go code snippets. If the target Go version, concurrency model, or specific problem is unclear, state what is missing before proceeding.

Production patterns for Go concurrency including goroutines, channels, synchronization primitives, and context management.

## When to Use This Skill

- Building concurrent Go applications
- Implementing worker pools and pipelines
- Managing goroutine lifecycles
- Using channels for communication
- Debugging race conditions
- Implementing graceful shutdown

## Core Concepts

### 1. Go Concurrency Primitives

| Primitive         | Purpose                          |
| ----------------- | -------------------------------- |
| `goroutine`       | Lightweight concurrent execution |
| `channel`         | Communication between goroutines |
| `select`          | Multiplex channel operations     |
| `sync.Mutex`      | Mutual exclusion                 |
| `sync.WaitGroup`  | Wait for goroutines to complete  |
| `context.Context` | Cancellation and deadlines       |

### 2. Go Concurrency Mantra

```
Don't communicate by sharing memory;
share memory by communicating.
```

## Quick Start

```go
package main

import (
    "context"
    "fmt"
    "sync"
    "time"
)

func main() {
    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()

    results := make(chan string, 10)
    var wg sync.WaitGroup

    // Spawn workers
    for i := 0; i < 3; i++ {
        wg.Add(1)
        go worker(ctx, i, results, &wg)
    }

    // Close results when done
    go func() {
        wg.Wait()
        close(results)
    }()

    // Collect results
    for result := range results {
        fmt.Println(result)
    }
}

func worker(ctx context.Context, id int, results chan<- string, wg *sync.WaitGroup) {
    defer wg.Done()

    select {
    case <-ctx.Done():
        return
    case results <- fmt.Sprintf("Worker %d done", id):
    }
}
```

## Detailed patterns and worked examples

Detailed pattern documentation lives in `references/details.md`. Read that file when the navigation tier above is insufficient.

## Best Practices

### Do's

- **Use context** - For cancellation and deadlines
- **Close channels** - From sender side only
- **Use errgroup** - For concurrent operations with errors
- **Buffer channels** - When you know the count
- **Prefer channels** - Over mutexes when possible

### Cautions

- **Every goroutine needs an exit path** - leaked goroutines accumulate silently
- **Close channels from the sender only** - receiver-side close panics
- **Prefer message passing over shared memory** - reach for sync.Mutex only when channels are unwieldy
- **Always check ctx.Done()** - ignoring cancellation makes shutdown unreliable
- **Use sync primitives for coordination** - time.Sleep is not synchronization
