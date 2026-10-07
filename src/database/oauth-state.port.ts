export interface DeviceAccountMembershipFilter {
  did?: string;
  deviceId?: string;
}

export interface DeviceAccountMembershipReader {
  findKeys(filter: DeviceAccountMembershipFilter): Promise<string[]>;
}
