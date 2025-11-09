# QueueCTL — Background Job Queue System (Node.js)

**Backend Developer Internship Assignment | By Shriya Udupa**

QueueCTL is a **CLI-based background job queue system** built using **Node.js**.  
It allows you to **enqueue background jobs**, execute them via **multiple workers**, **retry failed jobs automatically with exponential backoff**, and move **permanently failed ones into a Dead Letter Queue (DLQ)** — all **persisted safely using SQLite**.

---

## ⚙️ Tech Stack

| Component       | Technology                     |
|----------------|--------------------------------|
| **Language**    | Node.js (v18+)                 |
| **Database**    | SQLite (via `better-sqlite3`)  |
| **Concurrency** | Multi-process workers (`child_process.fork`) |
| **CLI**         | Native Node.js                 |
| **Persistence** | Local SQLite DB (`~/.queuectl/queue.db`) |

---

## 🧰 Features

- Enqueue and manage background jobs via CLI  
- Multiple concurrent workers  
- Automatic retries with **exponential backoff**  
- **Dead Letter Queue (DLQ)** for failed jobs  
- Retry DLQ jobs manually  
- Graceful worker shutdown  
- Persistent job storage  
- Configurable retry and backoff parameters  

---

## ⚙️ Setup Instructions

### 1️⃣ Clone Repository

```bash
git clone https://github.com/<your-username>/queuectl-node.git
cd queuectl-node
2️⃣ Install Dependencies
bashnpm install
3️⃣ Verify Installation
bashnode queuectl.js status
Expected Output:
makefileJobs:
  pending    0
  processing 0
  completed  0
  failed     0
  dead       0
Workers:
  (none)

💻 CLI Commands
Enqueue Jobs
Successful Job
bashnode queuectl.js enqueue "{\"id\":\"job-ok\",\"command\":\"echo Hello from Node!\"}"
Failing Job (for retries + DLQ test)
bashnode queuectl.js enqueue "{\"id\":\"job-bad\",\"command\":\"bash -lc \\\"sleep 1 && exit 1\\\"\",\"max_retries\":2}"

Windows CMD syntax: Always escape quotes using \".


Worker Management
Start multiple workers
bashnode queuectl.js worker start --count 3
Stop workers gracefully
bashnode queuectl.js worker stop

View Job Status
bashnode queuectl.js status
Example Output:
luaJobs:
  pending    0
  processing 0
  completed  1
  failed     0
  dead       1
Workers:
  <worker-id> pid=xxxx status=running

List Jobs by State
List pending jobs
bashnode queuectl.js list --state pending
List DLQ jobs
bashnode queuectl.js list --state dead

Dead Letter Queue (DLQ)
List dead jobs
bashnode queuectl.js dlq list
Retry a DLQ job
bashnode queuectl.js dlq retry job-bad

Configuration Commands
Set retry and backoff configuration
bashnode queuectl.js config set max_retries 3
node queuectl.js config set backoff_base 2
View all configuration
bashnode queuectl.js config get

Job Lifecycle





























StateDescriptionpendingWaiting to be picked by a workerprocessingCurrently being executedcompletedSuccessfully executedfailedFailed but retryabledeadPermanently failed (moved to DLQ)

Lifecycle Flow
scsspending → processing → completed
           ↓
         failed (retry → backoff)
           ↓
           dead (DLQ)

🧠 Architecture Overview

SQLite Database: Stores all job metadata, worker states, and configuration.
Workers: Each worker process claims a pending job, executes it, and updates its state atomically.
Retry & Backoff: Failed jobs are re-enqueued using exponential backoff:inidelay = backoff_base ^ attempts
Dead Letter Queue (DLQ): Jobs that exhaust retries are moved to dead state.
Config Table: Stores runtime parameters like retry count and backoff base.
CLI Interface: Fully command-line driven control of the queue system.


💾 Persistence
All data (jobs, configs, worker states) is stored persistently in:
arduino~/.queuectl/queue.db

Ensures jobs survive restarts and system crashes.


🧪 Testing Guide





























ScenarioExpected ResultEnqueue valid jobCompletes successfullyEnqueue failing jobRetries with backoff, moves to DLQMultiple workersProcess jobs concurrently, no duplicatesRestart applicationJobs persist across restartsRetry DLQ jobMoves from dead → pending and executes again

🧭 Example Demo Flow
bash# 1. Add jobs
node queuectl.js enqueue "{\"id\":\"job-ok\",\"command\":\"echo Hello\"}"
node queuectl.js enqueue "{\"id\":\"job-bad\",\"command\":\"bash -lc \\\"exit 1\\\"\",\"max_retries\":2}"

# 2. Start workers
node queuectl.js worker start --count 3

# 3. Check status
node queuectl.js status

# 4. View dead jobs
node queuectl.js dlq list

# 5. Retry DLQ job
node queuectl.js dlq retry job-bad

# 6. Stop workers
node queuectl.js worker stop

🧾 Assumptions & Design Choices

Designed for local single-node environments.
SQLite chosen for simplicity and durability.
Synchronous DB access (no race conditions).
shell:true allows flexible command execution.
Job output stored inline in DB for simplicity.
