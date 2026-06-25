
Teja Guduguntla

+1 (502) 431-6633 | Los Angeles, CA | gteja9639@gmail.com | linkedin.com/in/tejag2 | https://licensebot-wocm.onrender.com/

## SUMMARY

Senior AI/Full Stack Engineer with 5+ years building RAG systems and the data pipelines underneath them. At Cisco, LicenseBot — built with LangChain, Pinecone, and Claude — handles Tier-1 Smart Licensing support: it cut manual triage time ~60% and deflects thousands of tickets a month. Alongside it, Anomaly Radar catches licensing data drift in real time (incident response from hours to minutes) and DataPulse keeps 10M+ device records clean. Before Cisco, at HCSC, I built ClaimSense and FraudRadar to flag bad healthcare claims before payout — Kafka and Spark over millions of records a day. I work across Python, FastAPI, React, TypeScript, Kafka, Kubernetes, and AWS/GCP, and I care most about making AI explain itself, so the people who depend on it actually trust it. Also building two open-source projects in parallel: AgriMind (a FastAPI + GPT-4o Vision crop-disease agent) and FarmOS MCP Server.

## TECHNICAL SKILLS

**AI & Intelligent Systems:** LLM Integration (OpenAI GPT-4, Claude API), LangChain, LangGraph, RAG Architectures, Vector Databases (Pinecone, ChromaDB, FAISS), Hybrid Search, Reranking, RAGAS Evaluation, ReAct Agents, MCP (Model Context Protocol), FastMCP, Guardrails-AI, Presidio (PII Detection), Mem0, Pydantic, Prompt Engineering, Hugging Face Transformers, Human-in-the-Loop Systems, Model Drift Monitoring

**Full Stack Development:** React.js, Angular, Vue.js, Node.js, Django, Flask, FastAPI, Spring Boot, TypeScript, RESTful APIs, GraphQL

**Data Engineering & ETL:** Apache Airflow, Apache Spark, Apache Kafka, Python Pipelines, Real-Time Streaming, Data Validation Frameworks

**Data Platforms & Databases:** PostgreSQL, MongoDB, Oracle, Snowflake, Cassandra, Redis, Elasticsearch, SQL Server, MySQL

**Visualization & Reporting:** Power BI, Grafana, Tableau, Streamlit, D3.js, Chart.js, AI-Generated Insights Dashboards

**Cloud & MLOps:** AWS (SageMaker, Lambda, S3, EC2), Azure (OpenAI Service, ML Studio), Docker, Kubernetes, MLflow, LangFuse, LiteLLM, DeepEval, PyTorch, tiktoken, CI/CD Pipelines

**AI Development Tools:** GitHub Copilot, Cursor AI, AI-Assisted Development, Automated Code Review, Git, Jenkins, GitHub Actions

## CERTIFICATIONS

- Certified Kubernetes Administrator (CKA)
- AWS Developer Associate
- DeepLearning.AI - LangChain for LLM Application Development

## PROFESSIONAL EXPERIENCE

**Senior AI/Full Stack Engineer - Smart Licensing & Automation Intelligence**
Cisco Systems, San Jose, CA | November 2023 - Present

- Spearheaded LicenseBot, a RAG-powered AI assistant (LangChain + Pinecone + Claude) that automated Tier-1 Smart Licensing support queries — reduced manual triage time by ~60% and deflected thousands of support tickets monthly.
- Architected Anomaly Radar, a proactive data-monitoring system that flagged licensing data drift in real time, cutting incident response from hours to minutes.
- Engineered DataPulse, an end-to-end data quality pipeline that improved Smart Licensing data accuracy across 10M+ device records.
- Built automation test frameworks (Java/TestNG) for SLP device HA switchover, multi-device registration, and post-upgrade syslog validation — eliminating ~80% of manual regression effort.
- Stack: Python, FastAPI, LangChain, Pinecone, Claude/OpenAI APIs, React, TypeScript, Kafka, Docker, Kubernetes, AWS, GCP.

**Full Stack Data Engineer - Healthcare Analytics & Intelligent Claims Processing**
HCSC (Health Care Service Corporation), Richardson, TX | October 2022 - October 2023

- Architected ClaimSense, a healthcare claims intelligence platform that used ML models to flag anomalous claims pre-adjudication, reducing fraudulent payouts.
- Built FraudRadar, a real-time fraud detection pipeline (Kafka + Spark + Python) processing millions of claims daily.
- Migrated legacy claims processing services to a cloud-native microservices architecture on AWS, improving throughput and reducing infrastructure cost.
- Stack: Python, Java Spring Boot, Kafka, Spark, AWS, React, PostgreSQL.

**Associate Full Stack Developer - Platform Intelligence & Data Services**
OpenText, Bengaluru, India | January 2020 – August 2021

- Built and maintained full-stack platform intelligence and data services features, contributing across front-end (React) and back-end systems design.

## PROJECTS

**LicenseBot: RAG Document Q&A Assistant** — [demo](https://licensebot-wocm.onrender.com/) · [github.com/Teja2205/licensebot](https://github.com/Teja2205/licensebot)
Open-source RAG app: upload any PDF, ask questions in plain English, get grounded answers with source citations. Retrieves relevant chunks at query time so answers stay grounded, not hallucinated. Stack: Groq (Llama 3.3-70B) for inference, Pinecone for vector search, Supabase for auth + conversation history, Hugging Face Inference API for embeddings, Streamlit UI, deployed on Render. Notable engineering: embedding consistency across docs and queries, cosine similarity over L2 for semantic search, and a prompt-level hallucination guard ("answer only from context").

**AgriMind: AI-Native Crop Disease Advisory Agent** *(In Progress)* — [github.com/Teja2205/AgriMind](https://github.com/Teja2205/AgriMind)
FastAPI + GPT-4o Vision agent that accepts a crop photo and crop type, retrieves relevant disease profiles from a RAG knowledge base, and returns a structured Pydantic diagnosis (disease name, severity, description, treatment). Agent loop calls the FarmOS MCP server for real-time weather, soil, and pest context before synthesizing the final diagnosis. Stack: Python, FastAPI, GPT-4o Vision, ChromaDB, LangChain, LangGraph, MCP client.

**FarmOS MCP Server: Open-Source Agricultural MCP Server** *(In Progress)* — [github.com/Teja2205/farmos-mcp](https://github.com/Teja2205/farmos-mcp)
Open-source MCP (Model Context Protocol) server built with FastMCP that exposes agricultural data APIs — weather forecasts, soil profiles, and pest alerts — as typed, callable tools for AI agents. Pydantic models for all tool outputs, API key auth, per-key rate limiting, SQLite usage logging, and GitHub Actions CI/CD. Stack: Python, FastMCP, Pydantic, SQLite, httpx.

**Agrivoltaics Simulation** — [github.com/Teja2205/agrivoltaics-simulatiopn](https://github.com/Teja2205/agrivoltaics-simulatiopn)
Full-stack Python simulation for optimizing agrivoltaics (solar + agriculture) systems with ML and AI.

## EDUCATION

**Master of Science in Computer Science** | University of Missouri at Kansas City | December 2022

**Bachelor of Technology in Computer Science and Engineering** | Jawaharlal Nehru Technological University | May 2020
