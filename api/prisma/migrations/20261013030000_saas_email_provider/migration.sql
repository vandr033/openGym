ALTER TABLE `EmailOtpChallenge`
  ADD COLUMN `providerSubmissionId` VARCHAR(255) NULL;

ALTER TABLE `OrganizationInvitation`
  ADD COLUMN `providerSubmissionId` VARCHAR(255) NULL;
