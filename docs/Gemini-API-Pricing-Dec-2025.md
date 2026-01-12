# Gemini API Pricing & Usage Limits (December 2025)

## 1. Free Tier Limits (Google AI Studio / Gemini CLI)

The free tier varies significantly based on whether you use an **API Key** or **OAuth (Google Account)**. For the Hybrid CLI Agent, **OAuth is recommended** for higher limits.

### A. OAuth / Personal Google Account (Best for CLI)
*Applies when logging in via `gcloud auth` or Gemini CLI's OAuth flow.*

| Metric | Limit | Models Included |
| :--- | :--- | :--- |
| **Requests Per Minute (RPM)** | **60 RPM** | Gemini 2.5 Pro, 2.5 Flash |
| **Requests Per Day (RPD)** | **1,000 RPD** | Gemini 2.5 Pro, 2.5 Flash |

### B. API Key (Standard Free Tier)
*Applies when using `GEMINI_API_KEY` without billing enabled.*

| Model | RPM | RPD | TPM (Tokens/Min) |
| :--- | :--- | :--- | :--- |
| **Gemini 2.5 Flash** | 10 | 250 | 250,000 |
| **Gemini 2.5 Pro** | 5 | 100 | 250,000 |
| **Gemini 2.5 Flash-Lite** | 15 | 1,000 | 250,000 |
| **Gemini 3 Pro (Preview)**| 10-50 | 100+ | 250,000 |

> **Note:** Data from the Free Tier (API Key) may be used to train Google's models. Paid tier data is not used for training.

---

## 2. Google One AI Premium

*   **Cost:** ~$20 / month
*   **API Benefits:** **NONE.**
    *   The subscription benefits (Gemini Advanced, larger context in chat) apply **only** to the consumer chat interface (`gemini.google.com`) and Workspace apps.
    *   It does **not** increase API limits for AI Studio or Vertex AI.
    *   Developers must use the Pay-As-You-Go API for higher limits.

---

## 3. Gemini API Pricing (Pay-As-You-Go)

Prices are per **1 Million Tokens**.

| Model | Input Cost (≤ 200k) | Output Cost (≤ 200k) | Long Context Input (> 200k) | Long Context Output (> 200k) |
| :--- | :--- | :--- | :--- | :--- |
| **Gemini 2.5 Flash** | **$0.15** | **$0.60** | $0.15 | $0.60 |
| **Gemini 2.5 Flash-Lite**| **$0.10** | **$0.40** | $0.10 | $0.40 |
| **Gemini 2.5 Pro** | **$1.25** | **$10.00** | $2.50 | $15.00 |
| **Gemini 3 Pro (Preview)**| **$2.00** | **$12.00** | $4.00 | $18.00 |

*   **Images:** ~$0.00265 per image (varies by resolution).
*   **Audio:** $1.00 per 1M tokens (Input).
*   **Context Caching:** ~$0.10 - $0.31 per 1M tokens cached + storage fee ($4.50/1M/hr).

---

## 4. Vertex AI Pricing

Vertex AI pricing mirrors the Pay-As-You-Go API pricing but adds enterprise features:

*   **Standard Pricing:** Same as API table above.
*   **Grounding (Google Search):**
    *   **Gemini 2.5 Flash/Lite:** 1,500 free grounded requests/day.
    *   **Gemini 2.5 Pro:** 10,000 free grounded requests/day.
    *   **Overages:** ~$35 per 1,000 requests.
*   **Batch Prediction:** ~50% discount on standard rates (asynchronous).

## Summary for Hybrid Agent Strategy

1.  **Use Gemini 2.5 Flash (OAuth)** for the heavy lifting (reading logs/files). It gives you **1,000 requests/day for FREE** with a high 60 RPM limit.
2.  **Avoid API Keys** for the free tier if possible, as the limits (250 RPD) are much stricter.
3.  **Upgrade path:** If you exceed 1,000 RPD, switch to **Gemini 2.5 Flash Pay-As-You-Go**, which is incredibly cheap ($0.15/1M input). Reading a 100k token log file costs just **1.5 cents**.