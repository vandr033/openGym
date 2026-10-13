CREATE TABLE `WorkoutSession` (
  `id` CHAR(36) NOT NULL,
  `clientUserId` CHAR(36) NOT NULL,
  `organizationId` CHAR(36) NULL,
  `startedByUserId` CHAR(36) NOT NULL,
  `status` ENUM('ACTIVE', 'COMPLETED', 'CANCELLED') NOT NULL DEFAULT 'ACTIVE',
  `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `completedAt` DATETIME(3) NULL,
  `cancelledAt` DATETIME(3) NULL,
  `updatedAt` DATETIME(3) NOT NULL,
  `version` INTEGER NOT NULL DEFAULT 1,
  `lastEventSeq` BIGINT NOT NULL DEFAULT 0,
  `routineSnapshot` JSON NULL,
  `completionSnapshot` JSON NULL,
  `notes` VARCHAR(1000) NULL,
  `source` VARCHAR(40) NOT NULL DEFAULT 'freestyle',
  `metadata` JSON NULL,
  UNIQUE INDEX `WorkoutSession_id_clientUserId_key` (`id`, `clientUserId`),
  INDEX `WorkoutSession_clientUserId_startedAt_idx` (`clientUserId`, `startedAt`),
  INDEX `WorkoutSession_organizationId_status_startedAt_idx` (`organizationId`, `status`, `startedAt`),
  PRIMARY KEY (`id`),
  CONSTRAINT `WorkoutSession_clientUserId_fkey` FOREIGN KEY (`clientUserId`) REFERENCES `User` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `WorkoutSession_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `WorkoutSession_startedByUserId_fkey` FOREIGN KEY (`startedByUserId`) REFERENCES `User` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci ENGINE=InnoDB;

CREATE TABLE `ClientActiveSession` (
  `clientUserId` CHAR(36) NOT NULL,
  `sessionId` CHAR(36) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `ClientActiveSession_sessionId_key` (`sessionId`),
  UNIQUE INDEX `ClientActiveSession_sessionId_clientUserId_key` (`sessionId`, `clientUserId`),
  PRIMARY KEY (`clientUserId`),
  CONSTRAINT `ClientActiveSession_clientUserId_fkey` FOREIGN KEY (`clientUserId`) REFERENCES `User` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `ClientActiveSession_sessionId_clientUserId_fkey` FOREIGN KEY (`sessionId`, `clientUserId`) REFERENCES `WorkoutSession` (`id`, `clientUserId`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci ENGINE=InnoDB;

CREATE TABLE `WorkoutSessionExercise` (
  `id` CHAR(36) NOT NULL,
  `sessionId` CHAR(36) NOT NULL,
  `exerciseId` VARCHAR(128) NOT NULL,
  `name` VARCHAR(160) NOT NULL,
  `routineSlotId` VARCHAR(128) NULL,
  `position` INTEGER NOT NULL,
  `snapshot` JSON NOT NULL,
  `prescription` JSON NULL,
  `notes` VARCHAR(500) NULL,
  `noProgression` BOOLEAN NOT NULL DEFAULT false,
  `version` INTEGER NOT NULL DEFAULT 1,
  `deletedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `WorkoutSessionExercise_sessionId_routineSlotId_key` (`sessionId`, `routineSlotId`),
  INDEX `WorkoutSessionExercise_sessionId_position_deletedAt_idx` (`sessionId`, `position`, `deletedAt`),
  PRIMARY KEY (`id`),
  CONSTRAINT `WorkoutSessionExercise_sessionId_fkey` FOREIGN KEY (`sessionId`) REFERENCES `WorkoutSession` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci ENGINE=InnoDB;

CREATE TABLE `WorkoutSet` (
  `id` CHAR(36) NOT NULL,
  `sessionExerciseId` CHAR(36) NOT NULL,
  `plannedSetSlotId` VARCHAR(128) NULL,
  `position` INTEGER NOT NULL,
  `phase` ENUM('WARMUP', 'WORK') NOT NULL DEFAULT 'WORK',
  `weightKg` DECIMAL(9,3) NULL,
  `reps` INTEGER NULL,
  `durationSeconds` INTEGER NULL,
  `rir` DECIMAL(3,1) NULL,
  `rpe` DECIMAL(3,1) NULL,
  `done` BOOLEAN NOT NULL DEFAULT false,
  `notes` VARCHAR(500) NULL,
  `details` JSON NOT NULL,
  `version` INTEGER NOT NULL DEFAULT 1,
  `deletedAt` DATETIME(3) NULL,
  `createdByUserId` CHAR(36) NOT NULL,
  `updatedByUserId` CHAR(36) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `WorkoutSet_sessionExerciseId_plannedSetSlotId_key` (`sessionExerciseId`, `plannedSetSlotId`),
  INDEX `WorkoutSet_sessionExerciseId_position_deletedAt_idx` (`sessionExerciseId`, `position`, `deletedAt`),
  PRIMARY KEY (`id`),
  CONSTRAINT `WorkoutSet_sessionExerciseId_fkey` FOREIGN KEY (`sessionExerciseId`) REFERENCES `WorkoutSessionExercise` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `WorkoutSet_createdByUserId_fkey` FOREIGN KEY (`createdByUserId`) REFERENCES `User` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `WorkoutSet_updatedByUserId_fkey` FOREIGN KEY (`updatedByUserId`) REFERENCES `User` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci ENGINE=InnoDB;

CREATE TABLE `WorkoutOperation` (
  `id` CHAR(36) NOT NULL,
  `sessionId` CHAR(36) NOT NULL,
  `operationId` CHAR(36) NOT NULL,
  `actorUserId` CHAR(36) NOT NULL,
  `type` VARCHAR(40) NOT NULL,
  `requestHash` CHAR(64) NOT NULL,
  `result` JSON NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `WorkoutOperation_sessionId_operationId_key` (`sessionId`, `operationId`),
  INDEX `WorkoutOperation_actorUserId_operationId_idx` (`actorUserId`, `operationId`),
  PRIMARY KEY (`id`),
  CONSTRAINT `WorkoutOperation_sessionId_fkey` FOREIGN KEY (`sessionId`) REFERENCES `WorkoutSession` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `WorkoutOperation_actorUserId_fkey` FOREIGN KEY (`actorUserId`) REFERENCES `User` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci ENGINE=InnoDB;

CREATE TABLE `WorkoutEvent` (
  `id` CHAR(36) NOT NULL,
  `sessionId` CHAR(36) NOT NULL,
  `sequence` BIGINT NOT NULL,
  `operationId` CHAR(36) NOT NULL,
  `actorUserId` CHAR(36) NOT NULL,
  `type` VARCHAR(40) NOT NULL,
  `payload` JSON NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `WorkoutEvent_sessionId_sequence_key` (`sessionId`, `sequence`),
  INDEX `WorkoutEvent_sessionId_createdAt_idx` (`sessionId`, `createdAt`),
  PRIMARY KEY (`id`),
  CONSTRAINT `WorkoutEvent_sessionId_fkey` FOREIGN KEY (`sessionId`) REFERENCES `WorkoutSession` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `WorkoutEvent_sessionId_operationId_fkey` FOREIGN KEY (`sessionId`, `operationId`) REFERENCES `WorkoutOperation` (`sessionId`, `operationId`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `WorkoutEvent_actorUserId_fkey` FOREIGN KEY (`actorUserId`) REFERENCES `User` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci ENGINE=InnoDB;

CREATE TRIGGER `WorkoutEvent_no_update` BEFORE UPDATE ON `WorkoutEvent`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'WorkoutEvent is append-only';
CREATE TRIGGER `WorkoutEvent_no_delete` BEFORE DELETE ON `WorkoutEvent`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'WorkoutEvent is append-only';
CREATE TRIGGER `WorkoutOperation_no_update` BEFORE UPDATE ON `WorkoutOperation`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'WorkoutOperation is append-only';
CREATE TRIGGER `WorkoutOperation_no_delete` BEFORE DELETE ON `WorkoutOperation`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'WorkoutOperation is append-only';
