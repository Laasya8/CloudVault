# Phase 8: Cloud Deployment Documentation
## CloudVault AWS EC2 Distributed Deployment Guide

In Phase 8, we deploy CloudVault to public cloud infrastructure using **AWS EC2 (Elastic Compute Cloud)**. This guide outlines the steps to build, configure, deploy, and secure the Coordinator, PostgreSQL database, and three independent storage nodes across separate virtual machines, utilizing Docker container runtimes.

---

## 1. Cloud Architecture & Concepts

### What AWS EC2 Is
**AWS EC2 (Elastic Compute Cloud)** provides scalable virtual computing servers (called *instances*) in the Amazon Web Services cloud. It allows developers to rent virtual machines (VMs) with custom CPU, RAM, storage, and networking configurations.

### Why EC2 Is Appropriate for This Project
EC2 is the ideal infrastructure choice for a student project on distributed systems:
1.  **Low-Level Control**: It grants full root-level SSH access. This allows students to install Docker, inspect local storage directories, configure networking ports, and manually disrupt services (to demonstrate failures).
2.  **Low Cost (Free Tier Eligible)**: Under the AWS Free Tier, users get 750 hours/month of `t2.micro` or `t3.micro` instances for free. We can run our entire cluster within these limits.
3.  **Realistic Networking**: Unlike running multiple containers on a local docker bridge network, EC2 instances reside on distinct virtual cards, introducing actual WAN network latency, private IP routing, and firewall rules.

### Difference Between Local Docker Nodes and Cloud VMs

| Feature | Local Docker Nodes (Phase 5-7) | Cloud EC2 VMs (Phase 8) |
| :--- | :--- | :--- |
| **Physical Isolation** | None. All containers share the host CPU, memory, and hard drive. | High. Each VM runs on separate physical hardware blades inside Amazon's data centers. |
| **Network Pathing** | Internal virtual bridge network. Zero network latency (0ms) and unlimited bandwidth. | Real network adapters. Communication travels through private routers, introducing latency and packet overhead. |
| **Redundancy** | Fake. If the host machine goes offline, all nodes die. | Real. If one EC2 hardware host crashes, only that node goes down; other nodes survive. |
| **Access Control** | Open localhost ports. | Firewalled security groups. Access is locked down at the hypervisor network level. |

---

## 2. Network & Security Architecture

To secure our distributed cloud storage cluster, we isolate storage workers from public traffic:

```
[Internet Client]
       │
       ▼ HTTP (Port 3000)
┌──────────────────────────────────────────────────────────────┐
│                  AWS VPC (10.0.0.0/16)                       │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │               Public Subnet (10.0.1.0/24)              │  │
│  │                                                        │  │
│  │  ┌─────────────────────────┐                           │  │
│  │  │  Coordinator Instance    │ ─── Exposes Port 3000     │  │
│  │  │  (PostgreSQL + Backend) │     to the public internet│  │
│  │  └────────────┬────────────┘                           │  │
│  └───────────────┼────────────────────────────────────────┘  │
│                  │                                           │
│                  │ Private VPC Communication (Port 5001)     │
│                  ▼                                           │
│  ┌────────────────────────────────────────────────────────┐  │
│  │               Private Subnet (10.0.2.0/24)             │  │
│  │                                                        │  │
│  │  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐  │  │
│  │  │  Node A VM   │    │  Node B VM   │    │  Node C VM   │  │  │
│  │  │  (Port 5001) │    │  (Port 5001) │    │  (Port 5001) │  │  │
│  │  └──────────────┘    └──────────────┘    └──────────────┘  │  │
│  │                                                        │  │
│  │  * Security Group blocks all public internet access.   │  │
│  │  * Only accepts traffic from the Coordinator IP.      │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

### Security Group Settings (Firewalls)

1.  **Coordinator Security Group (`sg-coordinator`)**:
    *   **Inbound**:
        *   Port `3000` from `0.0.0.0/0` (public access for client file uploads/downloads).
        *   Port `22` (SSH) from your specific administrator IP only (prevents brute-force SSH attacks).
    *   **Outbound**: Allowed to connect everywhere.
2.  **Storage Nodes Security Group (`sg-storage-nodes`)**:
    *   **Inbound**:
        *   Port `5001` from `sg-coordinator` Security Group ID (allows ONLY the coordinator to write/read chunks).
        *   Port `22` (SSH) from your private administrator IP (or through a Bastion Host).
    *   **Outbound**: None (or limited to updating packages). Highly secure.

---

## 3. Persistent Storage & Secrets

### Persistent Storage
Each storage VM is allocated an **AWS EBS (Elastic Block Store) GP3 Volume** (typically 8 GB, default size). 
When we run Docker on the VM, we mount the host path `/home/ec2-user/data` to `/app/data` inside the storage container. This ensures that even if we upgrade our storage node container or reboot the VM instance, the raw file chunks remain preserved on the network EBS drive.

### Environment Variables & Secrets
To avoid hardcoding credentials (such as DB passwords), all configurations are loaded dynamically via a `.env` file on the Coordinator instance:
```env
PORT=3000
DATABASE_URL=postgres://cloudvault_user:SuperSecretPassword123@localhost:5432/cloudvault_metadata
STORAGE_NODES=node-a=http://[NODE_A_PRIVATE_IP]:5001,node-b=http://[NODE_B_PRIVATE_IP]:5001,node-c=http://[NODE_C_PRIVATE_IP]:5001
CHUNK_SIZE=1048576
REPLICATION_FACTOR=2
```

---

## 4. Deployment Step-by-Step

### Step 1: Launch EC2 Instances
Launch 4 EC2 instances using the AWS Console or AWS CLI (`t2.micro` running Amazon Linux 2023):
*   `cloudvault-coordinator` (allocate Elastic IP for static public address).
*   `cloudvault-node-a`, `cloudvault-node-b`, `cloudvault-node-c`.

### Step 2: Install Docker on All Instances
SSH into each instance and execute:
```bash
sudo dnf update -y
sudo dnf install docker -y
sudo systemctl enable --now docker
sudo usermod -aG docker ec2-user
```
*(Log out and log back in to apply group permissions).*

### Step 3: Deploy PostgreSQL & Coordinator on Coordinator Instance
On the `cloudvault-coordinator` instance:
1.  Clone your project repository or copy source directories.
2.  Create a production compose configuration `docker-compose.prod.yml`:
    ```yaml
    version: '3.8'
    services:
      db:
        image: postgres:15-alpine
        container_name: cloudvault-db
        environment:
          POSTGRES_USER: cloudvault_user
          POSTGRES_PASSWORD: SuperSecretPassword123
          POSTGRES_DB: cloudvault_metadata
        ports:
          - "127.0.0.1:5432:5432"  # Lock DB to localhost (only accessible internally)
        volumes:
          - pgdata:/var/lib/postgresql/data
        restart: unless-stopped

      backend:
        build: ./backend
        container_name: cloudvault-coordinator
        ports:
          - "3000:3000"
        environment:
          - PORT=3000
          - DATABASE_URL=postgres://cloudvault_user:SuperSecretPassword123@db:5432/cloudvault_metadata
          - STORAGE_NODES=node-a=http://[NODE_A_PRIVATE_IP]:5001,node-b=http://[NODE_B_PRIVATE_IP]:5001,node-c=http://[NODE_C_PRIVATE_IP]:5001
          - REPLICATION_FACTOR=2
        depends_on:
          - db
        restart: unless-stopped
    volumes:
      pgdata:
    ```
3.  Launch the services:
    ```bash
    docker compose -f docker-compose.prod.yml up -d --build
    ```

### Step 4: Deploy Storage Nodes
On each of the three storage node instances (`node-a`, `node-b`, `node-c`):
1.  Copy the [`storage-node/`](file:///f:/data/Laasya/Antigravity-projects/CloudVault/storage-node) directory to the server.
2.  Run the docker container, mounting host folders:
    ```bash
    docker build -t cloudvault-storage-node ./storage-node
    docker run -d \
      --name cloudvault-node \
      -p 5001:5001 \
      -v /home/ec2-user/data:/app/data \
      -e PORT=5001 \
      -e STORAGE_DIR=/app/data \
      --restart unless-stopped \
      cloudvault-storage-node
    ```

---

## 5. Validation and Testing Operations

### Test Node Health & Connectivity
Verify that the Coordinator can reach all storage instances over the private network:
```bash
curl http://[COORDINATOR_PUBLIC_IP]:3000/api/nodes
```
All nodes should return `"status": "ONLINE"`.

### Test File Upload & Reassembled Download
From your local computer:
```bash
# Upload file to cloud coordinator
curl -X POST -F "file=@my-photo.jpg" http://[COORDINATOR_PUBLIC_IP]:3000/api/upload

# Download file from cloud coordinator
curl -o downloaded-photo.jpg http://[COORDINATOR_PUBLIC_IP]:3000/api/download/<FILE_ID>
```

### Test Node Failure and Active Recovery
1.  Simulate a failure on `node-a`:
    ```bash
    curl -X POST http://[COORDINATOR_PUBLIC_IP]:3000/api/nodes/node-a/simulate-failure
    ```
2.  Inspect Coordinator logs:
    ```bash
    docker logs cloudvault-coordinator
    ```
    You will see the background self-healing scanner detect the failure and copy chunks from `node-b` (online replica) to `node-c` (online node that does not hold the chunk), updating PostgreSQL metadata on the fly.
3.  Recover the node:
    ```bash
    curl -X POST http://[COORDINATOR_PUBLIC_IP]:3000/api/nodes/node-a/recover
    ```

---

## 6. Financial & Operational Management

### Cost Considerations (Staying in Free Tier)
AWS offers a generous free tier, but resources must be managed to avoid charges:
*   Ensure all 4 EC2 instances are created using the `t2.micro` or `t3.micro` instance types.
*   AWS allows up to **30 GB** of total EBS storage across all Free Tier instances. Limit each instance's EBS volume to **8 GB** (4 instances $\times$ 8 GB = 32 GB, slightly over 30 GB. To stay strictly free, set the 3 storage nodes to **7 GB** EBS each, and the coordinator to **8 GB** EBS, keeping total storage at 29 GB).

### Shutting Down Resources When Not in Use
To ensure you do not incur charges when the project is not being active:
1.  **Stop Instances**: Go to the AWS EC2 Console, select the 4 instances, go to **Instance State** and click **Stop Instance**. Stopped instances do not charge for virtual CPU or RAM (only minor EBS disk storage charges apply, which is pennies per month).
2.  **Terminate Instances**: When the semester or project is fully completed, click **Terminate Instance**. This permanently deletes the VMs and their attached EBS volumes, removing all active resources from your AWS account billing cycle.
