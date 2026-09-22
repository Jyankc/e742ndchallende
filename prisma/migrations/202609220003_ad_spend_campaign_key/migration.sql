ALTER TABLE "ad_spend"
    DROP CONSTRAINT "ad_spend_pkey",
    ADD CONSTRAINT "ad_spend_pkey" PRIMARY KEY ("company_id", "date", "platform", "campaign_id");
