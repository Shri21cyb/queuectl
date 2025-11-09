# 🚀 QueueCTL — Background Job Queue System (Node.js)

### Backend Developer Internship Assignment | By **Shriya Udupa**

---

## 🧩 Overview

**QueueCTL** is a **CLI-based background job queue system** built using **Node.js**.  
It allows you to enqueue background jobs, execute them via multiple workers, retry failed jobs automatically with **exponential backoff**, and move permanently failed ones into a **Dead Letter Queue (DLQ)** — all persisted safely using **SQLite**.

---

## ⚙️ Tech Stack

| Component | Technology |
|------------|-------------|
| **Language** | Node.js (v18+) |
| **Database** | SQLite (via `better-sqlite3`) |
| **Concurrency** | Multi-process workers (`child_process.fork`) |
| **CLI** | Native Node.js |
| **Persistence** | Local SQLite DB (`~/.queuectl/queue.db`) |

---

## 🧰 Features

- Enqueue and manage background jobs via CLI  
- Multiple concurrent workers  
- Automatic retries with exponential backoff  
- Dead Letter Queue (DLQ) for failed jobs  
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
bash
Copy code
npm install
3️⃣ Verify Installation
bash
Copy code
node queuectl.js status
Expected Output:

makefile
Copy code
Jobs:
  pending    0
  processing 0
  completed  0
  failed     0
  dead       0
Workers:
  (none)
💻 CLI Commands
🔹 Enqueue Jobs
✅ Successful Job

bash
Copy code
node queuectl.js enqueue "{\"id\":\"job-ok\",\"command\":\"echo Hello from Node!\"}"
❌ Failing Job (for retries + DLQ test)

bash
Copy code
node queuectl.js enqueue "{\"id\":\"job-bad\",\"command\":\"bash -lc \\\"sleep 1 && exit 1\\\"\",\"max_retries\":2}"
💡 Windows CMD syntax: always escape quotes using \".

🔹 Worker Management
Start multiple workers:

bash
Copy code
node queuectl.js worker start --count 3
Stop workers gracefully:

bash
Copy code
node queuectl.js worker stop
🔹 View Job Status
bash
Copy code
node queuectl.js status
Example Output:

lua
Copy code
Jobs:
  pending    0
  processing 0
  completed  1
  failed     0
  dead       1
Workers:
  <worker-id> pid=xxxx status=running
🔹 List Jobs by State
List pending jobs:

bash
Copy code
node queuectl.js list --state pending
List DLQ jobs:

bash
Copy code
node queuectl.js list --state dead
🔹 Dead Letter Queue (DLQ)
List dead jobs:

bash
Copy code
node queuectl.js dlq list
Retry a DLQ job:

bash
Copy code
node queuectl.js dlq retry job-bad
🔹 Configuration Commands
Set retry and backoff configuration:

bash
Copy code
node queuectl.js config set max_retries 3
node queuectl.js config set backoff_base 2
View all configuration:

bash
Copy code
node queuectl.js config get
🔄 Job Lifecycle
State	Description
pending	Waiting to be picked by a worker
processing	Currently being executed
completed	Successfully executed
failed	Failed but retryable
dead	Permanently failed (moved to DLQ)

📊 Lifecycle Flow
scss
Copy code
pending → processing → completed
           ↓
         failed (retry → backoff)
           ↓
           dead (DLQ)
🧠 Architecture Overview
SQLite Database:
Stores all job metadata, worker states, and configuration.

Workers:
Each worker process claims a pending job, executes it, and updates its state atomically.

Retry & Backoff:
Failed jobs are re-enqueued using exponential backoff:

ini
Copy code
delay = backoff_base ^ attempts
Dead Letter Queue (DLQ):
Jobs that exhaust retries are moved to dead state.

Config Table:
Stores runtime parameters like retry count and backoff base.

CLI Interface:
Fully command-line driven control of the queue system.

💾 Persistence
All data (jobs, configs, worker states) is stored persistently in:

arduino
Copy code
~/.queuectl/queue.db
This ensures jobs survive restarts and system crashes.

🧪 Testing Guide
Scenario	Expected Result
Enqueue valid job	Completes successfully
Enqueue failing job	Retries with backoff, moves to DLQ
Multiple workers	Process jobs concurrently, no duplicates
Restart application	Jobs persist across restarts
Retry DLQ job	Moves from dead → pending and executes again

🧭 Example Demo Flow
bash
Copy code
# 1. Add jobs
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

Shell execution (shell:true) allows flexible commands.

Job output stored inline in DB for simplicity.

🏁 Evaluation Checklist
Requirement	Status
Enqueue jobs	✅
Multiple workers	✅
Retry with backoff	✅
DLQ functionality	✅
DLQ retry	✅
Persistent DB	✅
Graceful shutdown	✅
Configurable system	✅
Clear documentation	✅

🌟 Future Enhancements
Timeout handling for long-running jobs

Job priority system

Scheduled / delayed jobs (run_at)

Output logging to external files

Lightweight web dashboard for monitoring
