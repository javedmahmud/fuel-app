CREATE TABLE "fuel_type" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_code" text NOT NULL,
	"display_name" text NOT NULL,
	"category" text NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "fuel_type_source_code_unique" UNIQUE("source_code"),
	CONSTRAINT "fuel_type_category_check" CHECK ("fuel_type"."category" in ('petrol', 'diesel', 'lpg', 'other'))
);
--> statement-breakpoint
CREATE TABLE "station" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_station_code" text NOT NULL,
	"source" text DEFAULT 'NSW_FUEL_API' NOT NULL,
	"name" text NOT NULL,
	"brand" text,
	"address_line" text,
	"suburb" text,
	"postcode" text,
	"state" varchar(3),
	"latitude" numeric(8, 6) NOT NULL,
	"longitude" numeric(9, 6) NOT NULL,
	"lifecycle_state" text DEFAULT 'active' NOT NULL,
	"consecutive_missing_syncs" integer DEFAULT 0 NOT NULL,
	"source_updated_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "station_source_code_source_unique" UNIQUE("source_station_code","source"),
	CONSTRAINT "station_lifecycle_state_check" CHECK ("station"."lifecycle_state" in ('active', 'suspect', 'inactive'))
);
--> statement-breakpoint
CREATE TABLE "ingestion_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_type" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"api_calls_used" integer DEFAULT 0 NOT NULL,
	"records_received" integer DEFAULT 0 NOT NULL,
	"records_persisted" integer DEFAULT 0 NOT NULL,
	"records_rejected" integer DEFAULT 0 NOT NULL,
	"failure_reason" text,
	CONSTRAINT "ingestion_run_job_type_check" CHECK ("ingestion_run"."job_type" in ('new_prices', 'full_sync', 'ref_data', 'rollup')),
	CONSTRAINT "ingestion_run_status_check" CHECK ("ingestion_run"."status" in ('running', 'success', 'partial', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "fuel_price_observation" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"station_id" uuid NOT NULL,
	"fuel_type_id" uuid NOT NULL,
	"price_tenths_cpl" integer NOT NULL,
	"source_reported_at" timestamp with time zone NOT NULL,
	"retrieved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ingestion_run_id" uuid,
	"source" text DEFAULT 'NSW_FUEL_API' NOT NULL,
	"raw_payload" jsonb,
	"content_hash" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_price_rollup" (
	"station_id" uuid NOT NULL,
	"fuel_type_id" uuid NOT NULL,
	"price_date" date NOT NULL,
	"time_weighted_avg_tenths" integer,
	"min_tenths_cpl" integer,
	"max_tenths_cpl" integer,
	"open_tenths_cpl" integer,
	"close_tenths_cpl" integer,
	"observation_count" integer DEFAULT 0 NOT NULL,
	"carried_forward" boolean DEFAULT false NOT NULL,
	"opening_price_age_days" integer,
	"partial_day" boolean DEFAULT false NOT NULL,
	"method_version" text NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_price_rollup_station_id_fuel_type_id_price_date_pk" PRIMARY KEY("station_id","fuel_type_id","price_date")
);
--> statement-breakpoint
CREATE TABLE "api_response_journal" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ingestion_run_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"http_status" integer NOT NULL,
	"raw_body" "bytea" NOT NULL,
	"status" text DEFAULT 'unprocessed' NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"failure_reason" text,
	CONSTRAINT "journal_status_check" CHECK ("api_response_journal"."status" in ('unprocessed', 'processed', 'unparsed'))
);
--> statement-breakpoint
CREATE TABLE "api_call_ledger" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ingestion_run_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"http_status" integer,
	"duration_ms" integer,
	"called_at" timestamp with time zone DEFAULT now() NOT NULL,
	"billing_month" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_user" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"auth_provider_user_id" text,
	"email" text,
	"default_fuel_type_id" uuid,
	"default_latitude" numeric(8, 6),
	"default_longitude" numeric(9, 6),
	"default_locality_label" text,
	"maximum_detour_km" numeric(6, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "app_user_auth_provider_user_id_unique" UNIQUE("auth_provider_user_id")
);
--> statement-breakpoint
CREATE TABLE "vehicle_profile" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"tank_capacity_litres" numeric(6, 2),
	"consumption_l_per_100km" numeric(5, 2),
	"current_fuel_fraction" numeric(3, 2),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "price_alert" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"fuel_type_id" uuid NOT NULL,
	"centre_latitude" numeric(8, 6) NOT NULL,
	"centre_longitude" numeric(9, 6) NOT NULL,
	"radius_km" numeric(5, 2) NOT NULL,
	"target_price_tenths_cpl" integer NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone,
	"last_triggered_at" timestamp with time zone,
	"last_evaluated_at" timestamp with time zone,
	CONSTRAINT "price_alert_status_check" CHECK ("price_alert"."status" in ('active', 'triggered', 'expired', 'disabled'))
);
--> statement-breakpoint
CREATE TABLE "recommendation_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"session_hash" text,
	"recommended_station_id" uuid NOT NULL,
	"calculation_inputs" jsonb NOT NULL,
	"output_metrics" jsonb NOT NULL,
	"reason_codes" text[] NOT NULL,
	"engine_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fuel_price_observation" ADD CONSTRAINT "fuel_price_observation_station_id_station_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."station"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fuel_price_observation" ADD CONSTRAINT "fuel_price_observation_fuel_type_id_fuel_type_id_fk" FOREIGN KEY ("fuel_type_id") REFERENCES "public"."fuel_type"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fuel_price_observation" ADD CONSTRAINT "fuel_price_observation_ingestion_run_id_ingestion_run_id_fk" FOREIGN KEY ("ingestion_run_id") REFERENCES "public"."ingestion_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_price_rollup" ADD CONSTRAINT "daily_price_rollup_station_id_station_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."station"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_price_rollup" ADD CONSTRAINT "daily_price_rollup_fuel_type_id_fuel_type_id_fk" FOREIGN KEY ("fuel_type_id") REFERENCES "public"."fuel_type"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_response_journal" ADD CONSTRAINT "api_response_journal_ingestion_run_id_ingestion_run_id_fk" FOREIGN KEY ("ingestion_run_id") REFERENCES "public"."ingestion_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_call_ledger" ADD CONSTRAINT "api_call_ledger_ingestion_run_id_ingestion_run_id_fk" FOREIGN KEY ("ingestion_run_id") REFERENCES "public"."ingestion_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_user" ADD CONSTRAINT "app_user_default_fuel_type_id_fuel_type_id_fk" FOREIGN KEY ("default_fuel_type_id") REFERENCES "public"."fuel_type"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_profile" ADD CONSTRAINT "vehicle_profile_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_alert" ADD CONSTRAINT "price_alert_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_alert" ADD CONSTRAINT "price_alert_fuel_type_id_fuel_type_id_fk" FOREIGN KEY ("fuel_type_id") REFERENCES "public"."fuel_type"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendation_log" ADD CONSTRAINT "recommendation_log_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendation_log" ADD CONSTRAINT "recommendation_log_recommended_station_id_station_id_fk" FOREIGN KEY ("recommended_station_id") REFERENCES "public"."station"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "station_lat_lng_active_idx" ON "station" USING btree ("latitude","longitude") WHERE "station"."lifecycle_state" <> 'inactive';--> statement-breakpoint
CREATE INDEX "observation_station_fuel_reported_idx" ON "fuel_price_observation" USING btree ("station_id","fuel_type_id","source_reported_at");--> statement-breakpoint
CREATE UNIQUE INDEX "observation_content_hash_unique_idx" ON "fuel_price_observation" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX "observation_retrieved_at_idx" ON "fuel_price_observation" USING btree ("retrieved_at");--> statement-breakpoint
CREATE INDEX "journal_unprocessed_idx" ON "api_response_journal" USING btree ("status") WHERE "api_response_journal"."status" <> 'processed';--> statement-breakpoint
CREATE INDEX "ledger_billing_month_idx" ON "api_call_ledger" USING btree ("billing_month");--> statement-breakpoint
CREATE UNIQUE INDEX "app_user_email_lower_unique_idx" ON "app_user" USING btree (lower("email")) WHERE "app_user"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "alert_active_fuel_type_idx" ON "price_alert" USING btree ("status","fuel_type_id") WHERE "price_alert"."status" = 'active';