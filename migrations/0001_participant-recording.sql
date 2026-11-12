ALTER TABLE "participant_tokens" ADD COLUMN "recording_session_id" text;--> statement-breakpoint
ALTER TABLE "participant_tokens" ADD COLUMN "recording" boolean DEFAULT false NOT NULL;