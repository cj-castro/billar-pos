# Billar POS → SaaS + AWS Migration: Technical Execution Plan

## 🧠 Context for Claude
You are acting as a senior software architect / lead developer. You have been given the open-source **Billar POS** repository:  
https://github.com/cj-castro/billar-pos

**Goal**: Transform this single-tenant, Docker Compose‑based POS into a **multi‑tenant SaaS** and deploy it on **AWS** with high availability, scalability, and a subscription business model.

---

## 📦 Current State (as found in the repo)

| Component          | Technology                              |
|--------------------|-----------------------------------------|
| Frontend           | React + TypeScript                      |
| Backend            | Python Flask + SQLAlchemy               |
| Real‑time updates  | Socket.IO (WebSockets)                  |
| Database           | PostgreSQL (containerized)              |
| Deployment         | Docker Compose (single host, localhost) |
| Auth               | Flask‑Login (session‑based)             |

**Strengths**:
- Feature‑rich: floor management, time‑based billing, POS, inventory, kitchen queue, promotions.
- Well‑structured for a single location.

**Weaknesses for SaaS**:
- No multi‑tenancy (single database, no tenant isolation).
- No user onboarding / store owner dashboard.
- No subscription/billing integration.
- WebSockets don’t scale horizontally.
- No cloud‑native features (auto‑scaling, managed DB, load balancing).

---

## 🚀 Phase 1: Multi‑Tenancy Overhaul (Must be done first)

### Strategy: **Schema‑per‑tenant** (or database‑per‑tenant)
- Recommended: **PostgreSQL schemas** – easier to manage than separate databases, still good isolation.
- Each tenant = a billiard bar / café.

### Required code changes

#### Backend (Flask)
1. **Add tenant identification middleware**
   - Extract tenant from subdomain (e.g., `venue1.yourapp.com`) or JWT claim.
   - Store tenant schema name in Flask `g` object.
2. **Modify SQLAlchemy models**
   - All tables must be created inside tenant schemas.
   - Use a `tenant_id` column (if using shared tables) or dynamically set the schema search path.
   - **Simpler approach**: Use Flask‑SQLAlchemy with `bind_key` per schema.
3. **Modify all queries**
   - Every API endpoint that reads/writes data must filter by `g.tenant_schema`.
   - This includes joins, inserts, updates, deletes.
4. **Migration path for existing data**
   - Create a management CLI command to migrate the current single‑tenant DB into a new tenant schema (called `default` or `master`).
   - Keep the old `public` schema as a template.

#### Frontend (React)
- No direct tenant logic – the frontend only cares about subdomain or a tenant ID passed from login.
- Update API client to send tenant context (e.g., `X-Tenant-ID` header) if not using subdomains.

#### Real‑time (Socket.IO)
- **Problem**: WebSockets currently broadcast to all connections. In multi‑tenant, must never leak data between tenants.
- **Solution**: Namespace per tenant or, better, a `tenant_id` filter on messages.
- **Implementation**:
  - When a client connects, join a room named `tenant_{id}`.
  - All server emissions go only to that room.


---

## 📈 Phase 2: SaaS Feature Set

### Required new components (from scratch)

| Feature                            | Description                                                                                     |
|------------------------------------|-------------------------------------------------------------------------------------------------|
| **Landing page**                   | Marketing site with pricing, features, testimonials.                                            |
| **User (store owner) dashboard**   | Manage subscriptions, invite staff, view analytics, configure menu, taxes, etc.                 |
| **Tenant onboarding flow**         | After payment, automatically create new PostgreSQL schema, run migrations, set up default data. |
| **Subscription & billing**         | Integrate Stripe or Paddle. Plans: monthly per location.                                        |
| **Staff role management**          | Owner can add cashiers, managers with different permissions.                                    |
| **Multi‑store support** (optional) | One owner can own multiple venues – later phase.                                                |


### Tech choices for SaaS components
- **Payment**: Stripe Checkout / Stripe Billing + webhooks.
- **Background jobs**: Celery + Redis (for provisioning, email, reports).
- **Auth**: Move from Flask‑Login to Flask‑JWT‑Extended (JWT tokens) to support multi‑tenant and APIs.
- **Frontend**: Keep React; add React Router for dashboard.



---

## ☁️ Phase 3: AWS Migration (Production‑Ready)

### Target architecture



### Step‑by‑step deployment

1. **Containerize for production**
   - Build Docker images for both frontend (nginx serving React build) and backend (Flask + gunicorn).
   - Push to **Amazon ECR**.

2. **Managed database**
   - Create **RDS for PostgreSQL** (Multi‑AZ, t3.small or t3.medium).
   - Enable automated backups and encryption at rest.
   - Replace the containerized PostgreSQL with RDS endpoint.

3. **Session & real‑time scaling**
   - Deploy **ElastiCache for Redis** (cache.t3.micro or larger).
   - Configure Flask to use Redis for session storage (Flask‑Session).
   - **Critical**: Replace direct Socket.IO memory adapter with `socket.io-redis` adapter → all Fargate instances share state.

4. **Backend service**
   - Create ECS cluster (Fargate launch type).
   - Task definition: 2–4 backend containers (min 2 for HA).
   - Service discovery via ALB.

5. **Frontend hosting**
   - Build React static files, upload to **S3 bucket**.
   - Enable static website hosting or use **CloudFront** for CDN + custom domain + HTTPS.

6. **Networking**
   - VPC with public and private subnets across 2 AZs.
   - ALB in public subnets, ECS tasks + RDS + Redis in private subnets.

7. **CI/CD**
   - GitHub Actions workflow:
     - On push to `main`, build & push images to ECR.
     - Update ECS service (force new deployment).

### Expected effort: 2 weeks (after multi‑tenancy is done)

---

## 💰 Cost Estimates (AWS – us-east-1, monthly)

| Service                   | Dev / Staging (Single AZ) | Production (High Availability) |
|---------------------------|---------------------------|--------------------------------|
| ECS Fargate (2 vCPU, 4 GB) | ~$120                     | ~$240 (×2 tasks)               |
| RDS PostgreSQL (t3.small)  | ~$80                      | ~$280 (Multi‑AZ)               |
| ElastiCache Redis (t3.micro)| ~$26                     | ~$52 (Multi‑AZ)                |
| ALB + data transfer        | ~$25                      | ~$40                           |
| S3 + CloudFront            | ~$15                      | ~$15                           |
| **Total**                  | **~$270/month**           | **~$1,750/month**              |

**Cost reduction**: Use **Reserved Instances** (1‑year) → save 30‑40%.

---

## 💵 Pricing Strategy (for end customers)

| Plan        | Price (per location / month) | Features                                                                 |
|-------------|------------------------------|--------------------------------------------------------------------------|
| **Starter** | $29                          | Core POS, inventory, employee mgmt, basic reports.                      |
| **Pro**     | $79                          | + Multi‑location, loyalty, KDS integration, advanced analytics.         |
| **Enterprise** | Custom (>$200)           | + Dedicated support, custom features, SLA, API access.                  |

**Break‑even**:
- Monthly production cost = $1,750.
- At $29/tenant → need ~61 paying customers.
- At $79/tenant → need ~23 paying customers.
- Realistic: mix of plans → ~35–40 customers to break even.

---

## ⚠️ Risks & Mitigation

| Risk                                               | Mitigation                                                                                 |
|----------------------------------------------------|--------------------------------------------------------------------------------------------|
| **Data leak between tenants**                  | Rigorous tenant isolation testing; use separate DB schemas; never trust client‑side tenant ID. |
| **WebSocket scaling fails under load**         | Implement Redis adapter from day 1; load test with 100+ concurrent tenants.                |
| **PCI compliance (card payments)**             | Avoid storing card data; use Stripe Elements / Square – outsource compliance.              |
| **Cost overrun on AWS**                        | Set billing alerts; use AWS Budgets; start small (t3.micro for staging).                   |
| **Database migration from single‑tenant**      | Practice rollback script; take full pg_dump; run migration on staging first.               |
| **Lock‑in with schema‑per‑tenant**             | Keep migrations generic – can switch to DB‑per‑tenant later if needed.                     |

---

## 🧰 Recommended Tools & Services

| Purpose               | Tool / Service                        |
|-----------------------|---------------------------------------|
| Cloud                 | AWS (ECS, RDS, ElastiCache, S3, ALB)  |
| Infrastructure as Code| Terraform (or AWS CDK)                |
| CI/CD                 | GitHub Actions + AWS CLI              |
| Tenant onboarding     | Stripe webhooks + background worker   |
| Monitoring            | AWS CloudWatch + X‑Ray (or Datadog)   |
| Error tracking        | Sentry                                |
| Local development     | Docker Compose (with tenant sim)      |
| Load testing          | Locust or k6                          |

---

## 🗓️ Implementation Roadmap (8 weeks)

| Week | Focus                                                                 |
|------|-----------------------------------------------------------------------|
| 1    | Multi‑tenancy design + schema‑per‑tenant POC.                        |
| 2    | Backend tenant middleware + modify all models / queries.              |
| 3    | Frontend tenant awareness + Socket.IO rooms + Redis adapter.          |
| 4    | Stripe integration + owner dashboard (React).                         |
| 5    | AWS setup: VPC, RDS, ElastiCache, ECS (staging).                      |
| 6    | Deploy backend + frontend to staging; run migration script.           |
| 7    | Production hardening: multi‑AZ, backups, monitoring, autoscaling.     |
| 8    | Private beta (3–5 real bars) → fix bugs → launch public SaaS.         |

---

## ✅ Deliverables Checklist for Claude

When executing this plan, produce:

1. **Modified codebase** with multi‑tenancy, JWT auth, and Stripe integration.
2. **Terraform scripts** to provision AWS infrastructure.
3. **GitHub Actions YAML** for CI/CD.
4. **Migration script** to convert existing single‑tenant DB to multi‑tenant.
5. **Documentation** for onboarding new tenants automatically via Stripe webhook.
6. **Load‑testing report** showing WebSocket scaling with Redis.
7. **Cost calculator** spreadsheet (or script) for the SaaS owner.

---

## ❓ Questions to Clarify (if any)

- Should the initial launch support **only 1 location per tenant**, or allow multi‑location from day 1? (Recommend: single location first.)
- Do you need **offline mode** (POS works without internet)? Not currently in repo – would add 4 weeks.
- Preferred **JWT token storage** in frontend? (HttpOnly cookie recommended for security.)

Once these are answered, execution can begin.