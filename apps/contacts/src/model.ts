export const NETWORKS = [
  "neutron",
  "internet_computer",
  "bitcoin_mainnet",
  "dogecoin_mainnet",
  "ethereum_mainnet",
  "solana_mainnet",
] as const;

export type Network = (typeof NETWORKS)[number];
export type ContactKind = "person" | "self";

export type InternetComputerDestination = {
  network: "internet_computer";
  account: string;
};

export type NeutronDestination = {
  network: "neutron";
  principal: string;
};

export type ExternalDestination = {
  network: Exclude<Network, "internet_computer" | "neutron">;
  address: string;
};

export type Destination =
  | NeutronDestination
  | InternetComputerDestination
  | ExternalDestination;

export type ContactAddress = {
  id: string;
  label: string | null;
  destination: Destination;
  preferred: boolean;
};

export type ContactAddressDraft = Omit<ContactAddress, "id"> & {
  id: string | null;
};

export type Contact = {
  id: string;
  revision: string;
  kind: ContactKind;
  name: string;
  notes: string;
  addresses: ContactAddress[];
  createdAt: string;
  updatedAt: string;
};

export type ContactSummary = {
  id: string;
  revision: string;
  kind: ContactKind;
  name: string;
  addressCount: string;
  networks: Network[];
  updatedAt: string;
};

export type ContactDestination = {
  contactId: string;
  contactRevision: string;
  contactKind: ContactKind;
  contactName: string;
  address: ContactAddress;
};

export type SearchPage = {
  revision: string;
  contacts: ContactSummary[];
  total: string;
  nextOffset: string | null;
};

export type ResolvePage = {
  revision: string;
  destinations: ContactDestination[];
  total: string;
  nextOffset: string | null;
};

export type SaveContactInput = {
  id?: string | null;
  expectedRevision?: string | null;
  kind: ContactKind;
  name: string;
  notes?: string;
  addresses?: ContactAddressDraft[];
};

export type SaveContactResult = {
  revision: string;
  contact: Contact;
  duplicateContactIds: string[];
};

export const NETWORK_LABELS: Record<Network, string> = {
  neutron: "Neutron address",
  internet_computer: "Internet Computer",
  bitcoin_mainnet: "Bitcoin",
  dogecoin_mainnet: "Dogecoin",
  ethereum_mainnet: "Ethereum",
  solana_mainnet: "Solana",
};

export function isNetwork(value: unknown): value is Network {
  return typeof value === "string" && NETWORKS.includes(value as Network);
}

export function isContactKind(value: unknown): value is ContactKind {
  return value === "person" || value === "self";
}
