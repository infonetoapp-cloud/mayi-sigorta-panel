export interface TaskStatisticsCounts {
  readonly overdue: number;
  readonly dueToday: number;
  readonly upcoming: number;
  readonly completedLast30Days: number;
}
export interface TaskStatisticsEmployee extends TaskStatisticsCounts {
  readonly membershipId: string;
  readonly displayName: string | null;
  readonly status: 'ACTIVE' | 'SUSPENDED' | 'INACTIVE' | 'INVITED';
  readonly userActive: boolean;
}
export interface TaskStatisticsData {
  readonly view: 'self' | 'team';
  readonly canSeeTeam: boolean;
  readonly timezone: 'Europe/Istanbul';
  readonly todayLocalDate: string;
  readonly completionStart: string;
  readonly now: string;
  readonly summary: TaskStatisticsCounts;
  readonly unassigned: Omit<TaskStatisticsCounts, 'completedLast30Days'> | null;
  readonly employees: readonly TaskStatisticsEmployee[];
  readonly nextCursor: string | null;
}
