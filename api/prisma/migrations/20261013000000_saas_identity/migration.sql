-- CreateTable
CREATE TABLE `User` (
    `id` CHAR(36) NOT NULL,
    `legacyUid` VARCHAR(128) NULL,
    `legacyUidHash` CHAR(64) NULL,
    `displayName` VARCHAR(120) NULL,
    `status` ENUM('ACTIVE', 'DEACTIVATED', 'DELETED') NOT NULL DEFAULT 'ACTIVE',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `User_legacyUidHash_key`(`legacyUidHash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PlatformAdmin` (
    `userId` CHAR(36) NOT NULL,
    `grantedBy` VARCHAR(128) NOT NULL,
    `grantedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`userId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Organization` (
    `id` CHAR(36) NOT NULL,
    `type` ENUM('GYM', 'TRAINER_BUSINESS') NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `slug` VARCHAR(80) NOT NULL,
    `status` ENUM('ACTIVE', 'SUSPENDED') NOT NULL DEFAULT 'ACTIVE',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Organization_slug_key`(`slug`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `OrganizationMembership` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `userId` CHAR(36) NOT NULL,
    `role` ENUM('OWNER', 'ADMIN', 'TRAINER', 'STAFF') NOT NULL,
    `status` ENUM('ACTIVE', 'SUSPENDED') NOT NULL DEFAULT 'ACTIVE',
    `joinedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `OrganizationMembership_userId_status_idx`(`userId`, `status`),
    INDEX `OrganizationMembership_organizationId_role_status_idx`(`organizationId`, `role`, `status`),
    UNIQUE INDEX `OrganizationMembership_organizationId_userId_key`(`organizationId`, `userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ClientOrganizationEnrollment` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `clientUserId` CHAR(36) NOT NULL,
    `status` ENUM('ACTIVE', 'ENDED') NOT NULL DEFAULT 'ACTIVE',
    `enrolledAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `endedAt` DATETIME(3) NULL,

    INDEX `ClientOrganizationEnrollment_clientUserId_status_idx`(`clientUserId`, `status`),
    UNIQUE INDEX `ClientOrganizationEnrollment_organizationId_clientUserId_key`(`organizationId`, `clientUserId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TrainerClientRelationship` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `trainerUserId` CHAR(36) NOT NULL,
    `clientUserId` CHAR(36) NOT NULL,
    `status` ENUM('PENDING', 'ACTIVE', 'REVOKED') NOT NULL DEFAULT 'PENDING',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `acceptedAt` DATETIME(3) NULL,
    `revokedAt` DATETIME(3) NULL,

    INDEX `TrainerClientRelationship_clientUserId_status_idx`(`clientUserId`, `status`),
    INDEX `TrainerClientRelationship_trainerUserId_organizationId_statu_idx`(`trainerUserId`, `organizationId`, `status`),
    UNIQUE INDEX `TrainerClientRelationship_organizationId_trainerUserId_clien_key`(`organizationId`, `trainerUserId`, `clientUserId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ClientAccessGrant` (
    `id` CHAR(36) NOT NULL,
    `relationshipId` CHAR(36) NOT NULL,
    `scope` ENUM('VIEW_TRAINING', 'START_SESSION', 'LOG_SETS', 'MANAGE_ASSIGNMENTS', 'VIEW_BODYWEIGHT') NOT NULL,
    `grantedByUserId` CHAR(36) NOT NULL,
    `grantedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expiresAt` DATETIME(3) NOT NULL,
    `revokedAt` DATETIME(3) NULL,
    `revokedByUserId` CHAR(36) NULL,

    INDEX `ClientAccessGrant_relationshipId_scope_revokedAt_idx`(`relationshipId`, `scope`, `revokedAt`),
    INDEX `ClientAccessGrant_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `OrganizationInvitation` (
    `id` CHAR(36) NOT NULL,
    `organizationId` CHAR(36) NOT NULL,
    `type` ENUM('MEMBERSHIP', 'CLIENT_RELATIONSHIP') NOT NULL,
    `role` ENUM('OWNER', 'ADMIN', 'TRAINER', 'STAFF') NULL,
    `trainerUserId` CHAR(36) NULL,
    `targetLegacyUid` VARCHAR(128) NULL,
    `targetLegacyUidHash` CHAR(64) NULL,
    `createdByUserId` CHAR(36) NOT NULL,
    `createdByPlatformAdmin` BOOLEAN NOT NULL DEFAULT false,
    `acceptedByUserId` CHAR(36) NULL,
    `tokenHash` CHAR(64) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `acceptedAt` DATETIME(3) NULL,
    `revokedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `OrganizationInvitation_tokenHash_key`(`tokenHash`),
    INDEX `OrganizationInvitation_organizationId_createdAt_idx`(`organizationId`, `createdAt`),
    INDEX `OrganizationInvitation_expiresAt_acceptedAt_revokedAt_idx`(`expiresAt`, `acceptedAt`, `revokedAt`),
    INDEX `OrganizationInvitation_targetLegacyUidHash_idx`(`targetLegacyUidHash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AuditEvent` (
    `id` CHAR(36) NOT NULL,
    `actorType` ENUM('USER', 'OPERATOR') NOT NULL DEFAULT 'USER',
    `actorUserId` CHAR(36) NULL,
    `actorLegacyUid` VARCHAR(128) NULL,
    `actorRef` VARCHAR(128) NULL,
    `targetUserId` CHAR(36) NULL,
    `organizationId` CHAR(36) NULL,
    `action` VARCHAR(80) NOT NULL,
    `entityType` VARCHAR(80) NOT NULL,
    `entityId` VARCHAR(128) NULL,
    `metadata` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `AuditEvent_organizationId_createdAt_idx`(`organizationId`, `createdAt`),
    INDEX `AuditEvent_actorUserId_createdAt_idx`(`actorUserId`, `createdAt`),
    INDEX `AuditEvent_targetUserId_createdAt_idx`(`targetUserId`, `createdAt`),
    INDEX `AuditEvent_entityType_entityId_createdAt_idx`(`entityType`, `entityId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `PlatformAdmin` ADD CONSTRAINT `PlatformAdmin_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OrganizationMembership` ADD CONSTRAINT `OrganizationMembership_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OrganizationMembership` ADD CONSTRAINT `OrganizationMembership_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ClientOrganizationEnrollment` ADD CONSTRAINT `ClientOrganizationEnrollment_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ClientOrganizationEnrollment` ADD CONSTRAINT `ClientOrganizationEnrollment_clientUserId_fkey` FOREIGN KEY (`clientUserId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TrainerClientRelationship` ADD CONSTRAINT `TrainerClientRelationship_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TrainerClientRelationship` ADD CONSTRAINT `TrainerClientRelationship_trainerUserId_fkey` FOREIGN KEY (`trainerUserId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TrainerClientRelationship` ADD CONSTRAINT `TrainerClientRelationship_clientUserId_fkey` FOREIGN KEY (`clientUserId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ClientAccessGrant` ADD CONSTRAINT `ClientAccessGrant_relationshipId_fkey` FOREIGN KEY (`relationshipId`) REFERENCES `TrainerClientRelationship`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ClientAccessGrant` ADD CONSTRAINT `ClientAccessGrant_grantedByUserId_fkey` FOREIGN KEY (`grantedByUserId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ClientAccessGrant` ADD CONSTRAINT `ClientAccessGrant_revokedByUserId_fkey` FOREIGN KEY (`revokedByUserId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OrganizationInvitation` ADD CONSTRAINT `OrganizationInvitation_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OrganizationInvitation` ADD CONSTRAINT `OrganizationInvitation_createdByUserId_fkey` FOREIGN KEY (`createdByUserId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OrganizationInvitation` ADD CONSTRAINT `OrganizationInvitation_trainerUserId_fkey` FOREIGN KEY (`trainerUserId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OrganizationInvitation` ADD CONSTRAINT `OrganizationInvitation_acceptedByUserId_fkey` FOREIGN KEY (`acceptedByUserId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AuditEvent` ADD CONSTRAINT `AuditEvent_actorUserId_fkey` FOREIGN KEY (`actorUserId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AuditEvent` ADD CONSTRAINT `AuditEvent_targetUserId_fkey` FOREIGN KEY (`targetUserId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AuditEvent` ADD CONSTRAINT `AuditEvent_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `Organization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TRIGGER `AuditEvent_no_update` BEFORE UPDATE ON `AuditEvent`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'AuditEvent is append-only';
CREATE TRIGGER `AuditEvent_no_delete` BEFORE DELETE ON `AuditEvent`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'AuditEvent is append-only';
