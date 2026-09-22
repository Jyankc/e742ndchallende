-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Source" AS ENUM ('orders', 'refunds', 'email_events', 'ad_spend');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('processing', 'completed', 'failed');

-- CreateTable
CREATE TABLE "ingestion_runs" (
    "id" UUID NOT NULL,
    "company_id" TEXT NOT NULL,
    "source" "Source" NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "file_path" TEXT NOT NULL,
    "file_hash" TEXT NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'processing',
    "error" TEXT,
    "inserted_count" INTEGER NOT NULL DEFAULT 0,
    "duplicate_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ingestion_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "company_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "channel" TEXT NOT NULL,
    "gross" DECIMAL(18,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "customer_email" TEXT NOT NULL,
    "record_hash" TEXT NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("company_id","order_id")
);

-- CreateTable
CREATE TABLE "refunds" (
    "company_id" TEXT NOT NULL,
    "refund_id" TEXT NOT NULL,
    "refunded_at" TIMESTAMPTZ(3) NOT NULL,
    "order_id" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "record_hash" TEXT NOT NULL,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("company_id","refund_id")
);

-- CreateTable
CREATE TABLE "email_events" (
    "company_id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "record_hash" TEXT NOT NULL,

    CONSTRAINT "email_events_pkey" PRIMARY KEY ("company_id","event_id")
);

-- CreateTable
CREATE TABLE "ad_spend" (
    "company_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "spend" DECIMAL(18,2) NOT NULL,
    "record_hash" TEXT NOT NULL,

    CONSTRAINT "ad_spend_pkey" PRIMARY KEY ("company_id","date","platform")
);

-- CreateIndex
CREATE UNIQUE INDEX "ingestion_runs_company_id_source_idempotency_key_key" ON "ingestion_runs"("company_id", "source", "idempotency_key");

