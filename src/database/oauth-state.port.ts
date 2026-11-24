export interface DeviceAccountMembershipFilter {
  did?: string;
  deviceId?: string;
}

export interface DeviceAccountMemberships {
  findKeys(filter: DeviceAccountMembershipFilter): Promise<string[]>;
  remove(deviceId: string, did: string): Promise<boolean>;
}
