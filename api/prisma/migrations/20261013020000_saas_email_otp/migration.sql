CREATE TABLE `VerifiedEmailIdentity` (
  `id` CHAR(36) NOT NULL,
  `userId` CHAR(36) NOT NULL,
  `email` VARCHAR(254) NOT NULL,
  `verifiedAt` DATETIME(3) NOT NULL,
  `source` VARCHAR(40) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `VerifiedEmailIdentity_userId_key` (`userId`),
  UNIQUE INDEX `VerifiedEmailIdentity_email_key` (`email`),
  INDEX `VerifiedEmailIdentity_verifiedAt_idx` (`verifiedAt`),
  PRIMARY KEY (`id`),
  CONSTRAINT `VerifiedEmailIdentity_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci ENGINE=InnoDB;

CREATE TABLE `EmailOtpChallenge` (
  `id` CHAR(36) NOT NULL,
  `email` VARCHAR(254) NOT NULL,
  `purpose` ENUM('SIGNUP', 'LOGIN', 'LINK_EMAIL', 'PASSKEY_ADD') NOT NULL,
  `codeHash` CHAR(64) NOT NULL,
  `invitationId` CHAR(36) NULL,
  `legacyUid` VARCHAR(128) NULL,
  `registrationUid` VARCHAR(128) NULL,
  `sessionVersion` INTEGER NULL,
  `attempts` INTEGER NOT NULL DEFAULT 0,
  `expiresAt` DATETIME(3) NOT NULL,
  `registrationExpiresAt` DATETIME(3) NULL,
  `verifiedAt` DATETIME(3) NULL,
  `consumedAt` DATETIME(3) NULL,
  `completedAt` DATETIME(3) NULL,
  `profilePreferences` JSON NULL,
  `deliveryStatus` VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `EmailOtpChallenge_email_purpose_createdAt_idx` (`email`, `purpose`, `createdAt`),
  INDEX `EmailOtpChallenge_invitationId_createdAt_idx` (`invitationId`, `createdAt`),
  INDEX `EmailOtpChallenge_expiresAt_consumedAt_idx` (`expiresAt`, `consumedAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci ENGINE=InnoDB;

ALTER TABLE `User`
  ADD COLUMN `phone` VARCHAR(16) NULL,
  ADD COLUMN `onboardingCompletedAt` DATETIME(3) NULL;

ALTER TABLE `OrganizationInvitation`
  ADD COLUMN `targetEmail` VARCHAR(254) NULL,
  ADD COLUMN `invitationCodeHash` CHAR(64) NULL,
  ADD COLUMN `deliveryStatus` VARCHAR(16) NULL,
  ADD COLUMN `sentAt` DATETIME(3) NULL,
  ADD UNIQUE INDEX `OrganizationInvitation_invitationCodeHash_key` (`invitationCodeHash`);

ALTER TABLE `EmailOtpChallenge`
  ADD CONSTRAINT `EmailOtpChallenge_invitationId_fkey` FOREIGN KEY (`invitationId`) REFERENCES `OrganizationInvitation` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
