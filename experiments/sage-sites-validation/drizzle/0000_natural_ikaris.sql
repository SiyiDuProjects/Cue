CREATE TABLE `probe_events` (
	`scope` text NOT NULL,
	`id` text NOT NULL,
	`seq` integer NOT NULL,
	`revision` integer NOT NULL,
	`kind` text NOT NULL,
	`speaker` text,
	`body` text NOT NULL,
	`created` integer NOT NULL,
	PRIMARY KEY(`scope`, `id`)
);
--> statement-breakpoint
CREATE TABLE `probe_files` (
	`scope` text NOT NULL,
	`id` text NOT NULL,
	`hash` text NOT NULL,
	`size` integer NOT NULL,
	`mime` text NOT NULL,
	`sent` integer DEFAULT 0 NOT NULL,
	`removed` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`scope`, `id`)
);
--> statement-breakpoint
CREATE TABLE `probe_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`created` integer NOT NULL,
	`updated` integer NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	`cancelled` integer DEFAULT 0 NOT NULL
);
