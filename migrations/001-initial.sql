CREATE TABLE "allocation_tombstones" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"room_key" text NOT NULL,
	"generation" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "allocations" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"room_key" text NOT NULL,
	"generation" text NOT NULL,
	"media_provider" text,
	"slots" integer NOT NULL,
	"state" text NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"empty_since" timestamp with time zone,
	"revision" bigint DEFAULT 0 NOT NULL,
	"creation_inflight" boolean DEFAULT false NOT NULL,
	CONSTRAINT "allocations_slots_check" CHECK ("allocations"."slots" > 0),
	CONSTRAINT "allocations_state_check" CHECK ("allocations"."state" IN ('pending','active','ending','ended'))
);
--> statement-breakpoint
CREATE TABLE "client_generation_usage" (
	"client_id" text PRIMARY KEY NOT NULL,
	"generations" integer NOT NULL,
	"bytes" bigint NOT NULL,
	CONSTRAINT "client_generation_usage_generations_check" CHECK ("client_generation_usage"."generations" >= 0),
	CONSTRAINT "client_generation_usage_bytes_check" CHECK ("client_generation_usage"."bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "client_request_limits" (
	"client_id" text PRIMARY KEY NOT NULL,
	"timestamps" timestamp with time zone[] NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clients" (
	"id" text PRIMARY KEY NOT NULL,
	"origin" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"max_slots" integer NOT NULL,
	"max_rooms" integer NOT NULL,
	"allow_screen_share" boolean DEFAULT false NOT NULL,
	CONSTRAINT "clients_origin_unique" UNIQUE("origin"),
	CONSTRAINT "clients_max_slots_check" CHECK ("clients"."max_slots" > 0),
	CONSTRAINT "clients_max_rooms_check" CHECK ("clients"."max_rooms" > 0)
);
--> statement-breakpoint
CREATE TABLE "event_retention" (
	"client_id" text PRIMARY KEY NOT NULL,
	"pruned_through" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"allocation_id" text NOT NULL,
	"generation" text NOT NULL,
	"type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "participant_tokens" (
	"allocation_id" text NOT NULL,
	"identity_hash" text NOT NULL,
	"generation" uuid NOT NULL,
	CONSTRAINT "participant_tokens_allocation_id_identity_hash_pk" PRIMARY KEY("allocation_id","identity_hash")
);
--> statement-breakpoint
CREATE TABLE "received_webhooks" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relay_installation" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"installation_id" uuid NOT NULL,
	CONSTRAINT "relay_installation_installation_id_key" UNIQUE("installation_id"),
	CONSTRAINT "relay_installation_singleton_check" CHECK ("relay_installation"."singleton")
);
--> statement-breakpoint
ALTER TABLE "allocation_tombstones" ADD CONSTRAINT "allocation_tombstones_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_generation_usage" ADD CONSTRAINT "client_generation_usage_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_request_limits" ADD CONSTRAINT "client_request_limits_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_retention" ADD CONSTRAINT "event_retention_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_allocation_id_allocations_id_fk" FOREIGN KEY ("allocation_id") REFERENCES "allocations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participant_tokens" ADD CONSTRAINT "participant_tokens_allocation_id_allocations_id_fk" FOREIGN KEY ("allocation_id") REFERENCES "allocations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "allocation_tombstones_room_key_hash" ON "allocation_tombstones" USING hash ("room_key");--> statement-breakpoint
CREATE INDEX "allocation_tombstones_client" ON "allocation_tombstones" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "allocations_live_room" ON "allocations" USING btree ("client_id") WHERE "allocations"."state" <> 'ended';--> statement-breakpoint
CREATE INDEX "allocations_room_key_hash" ON "allocations" USING hash ("room_key");--> statement-breakpoint
CREATE INDEX "events_tenant_id" ON "events" USING btree ("client_id","id");--> statement-breakpoint
CREATE INDEX "events_created_at" ON "events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "received_webhooks_created_at" ON "received_webhooks" USING btree ("created_at");