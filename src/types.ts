export type GuildConfig = {
  guildId: string;
  modRoleId: string | null;
  adminRoleId: string | null;
  actionLogChannelId: string | null;
  strikeLogChannelId: string | null;
  alertChannelId: string | null;
  auditChannelId: string | null;
  quotaChannelId: string | null;
  quotaAlertChannelId: string | null;
  staffRegistrationChannelId: string | null;
  registrationRoleId: string | null;
  ticketTranscriptChannelId: string | null;
  linkedGuildId: string | null;
  moderationInvite: string | null;
  ownerUserId: string | null;
  ticketToolBotId: string | null;
  evidenceArchiveChannelId: string | null;
  appealLogChannelId: string | null;
  approvalChannelId: string | null;
  juniorHelpChannelId: string | null;
  stewardLogChannelId: string | null;
  juniorEscalationRoleIds: string[];
  juniorEscalationUserIds: string[];
  juniorOtherEscalationRoleIds: string[];
  juniorOtherEscalationUserIds: string[];
  interactiveLogEnabled: boolean;
  approvalEnabled: boolean;
  pointsEnabled: boolean;
  timezone: string;
  quotaRequiredLogs: number;
  quotaGraceLogs: number;
  quotaEnabled: boolean;
  quotaFrequencyDays: number;
  quotaCheckDay: number;
  quotaCheckHour: number;
  quotaCheckMinute: number;
  quotaPeriodStart: string | null;
  quotaPeriodEnd: string | null;
  quotaStatusMessageId: string | null;
  quotaWarningHours: number;
  quotaWarningSentAt: string | null;
  multiplierMilli: number;
  multiplierEndsAt: string | null;
  lastTranscriptMessageId: string | null;
  autoPunishDisabled: string[];
  loaChannelId: string | null;
  loaLogChannelId: string | null;
  shoutsChannelId: string | null;
  juniorApprovalPointsMilli: number;
  jailedRoleId: string | null;
  jailCategoryId: string | null;
  jailChatId: string | null;
  jailAnnouncementsId: string | null;
  promoteDemoteRoleIds: string[];
  isSecondary: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ActionPreset = {
  guildId: string;
  name: string;
  displayName: string;
  basePointsMilli: number;
  noActionPointsMilli: number;
  overrideBasePointsMilli: number | null;
  overrideNoActionPointsMilli: number | null;
  overrideEndsAt: string | null;
  overrideReason: string | null;
  overrideCreatedBy: string | null;
  defaultStrikes: number;
  evidenceRequired: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ModerationCase = {
  id: number;
  guildId: string;
  targetUserId: string;
  targetUsername: string;
  robloxUsername: string | null;
  discordUsername: string | null;
  robloxId: string | null;
  discordId: string | null;
  moderatorUserId: string;
  moderatorUsername: string;
  actionName: string;
  actionDisplayName: string | null;
  reason: string;
  evidence: string | null;
  notes: string | null;
  basePointsMilli: number;
  multiplierMilli: number;
  awardedPointsMilli: number;
  strikes: number;
  status: "active" | "void";
  flags: string;
  isLate: boolean;
  isNoAction: boolean;
  ticketId: string | null;
  transcriptUrl: string | null;
  mediaLinks: CaseMediaLink[];
  appealType: string | null;
  appealResult: "accepted" | "denied" | null;
  punishmentLength: string | null;
  approvalStatus: "pending" | "approved" | "denied" | null;
  approvalMessageId: string | null;
  juniorReviewStatus: "pending" | "approved" | "denied" | null;
  juniorReviewMessageId: string | null;
  logMessageId: string | null;
  logChannelId: string | null;
  createdAt: string;
  updatedAt: string;
  voidedAt: string | null;
  voidReason: string | null;
};

export type CaseMediaLink = {
  label: string;
  url: string;
  kind: "image" | "video" | "file";
  /** Original Discord CDN URL. Cleared (null) after the file is uploaded to the archive channel. */
  sourceUrl?: string | null;
  /** Stable idempotency key for the original attachment upload. */
  archiveKey?: string | null;
  /** True once the file has been successfully re-uploaded to the evidence archive channel. */
  archived?: boolean;
};

export type PendingTicketLog = {
  id: number;
  guildId: string;
  transcriptMessageId: string;
  transcriptChannelId: string;
  ticketId: string | null;
  ticketType: string;
  openerUserId: string | null;
  closedChannelId: string | null;
  closedChannelName: string | null;
  transcriptUrl: string | null;
  status: "pending" | "logged" | "dismissed" | "needs_review" | "overdue";
  createdAt: string;
  dueAt: string;
  loggedCaseId: number | null;
  adminNotes: string | null;
};

export type RobloxGame = {
  id: number;
  guildId: string;
  universeId: string;
  apiKey: string;
  name: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
};

export type LoaRequest = {
  id: number;
  guildId: string;
  userId: string;
  username: string;
  reason: string;
  durationText: string;
  expiresAt: string | null;
  status: "pending" | "approved" | "denied";
  approvalMessageId: string | null;
  approvalChannelId: string | null;
  approvedBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type QuotaMemberStatus = {
  userId: string;
  requiredLogs: number;
  loggedActions: number;
  missing: number;
  status: "met" | "close" | "missed" | "exempt";
  exemptionReason?: string;
};

export type QuotaReport = {
  guildId: string;
  periodStart: string;
  periodEnd: string;
  statuses: QuotaMemberStatus[];
  createdAt: string;
};
