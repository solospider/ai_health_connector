import { db } from "../db/pool.js";

function cleanAlias(value: string) {
  const alias = value.trim();
  if (alias.length < 1 || alias.length > 80) throw new Error("Profile name must be 1-80 characters");
  return alias;
}

export async function setDisplayName(userId: string, displayName: string) {
  const name = cleanAlias(displayName);
  await db.query(`UPDATE users SET display_name=$2 WHERE id=$1`, [userId, name]);
  return name;
}

export async function listFamilyProfiles(ownerUserId: string) {
  const self = await db.query(
    `SELECT u.id, u.email, u.display_name,
            EXISTS(SELECT 1 FROM connections c WHERE c.user_id=u.id AND c.provider='oura' AND c.status='active') AS oura_connected
       FROM users u WHERE u.id=$1 LIMIT 1`,
    [ownerUserId]
  );
  if (!self.rowCount) throw new Error("User not found");

  const shared = await db.query(
    `SELECT fa.profile_user_id AS id, fa.alias, u.email, u.display_name,
            EXISTS(SELECT 1 FROM connections c WHERE c.user_id=u.id AND c.provider='oura' AND c.status='active') AS oura_connected
       FROM family_access fa
       JOIN users u ON u.id=fa.profile_user_id
      WHERE fa.owner_user_id=$1 AND fa.status='active'
      ORDER BY lower(fa.alias), fa.created_at`,
    [ownerUserId]
  );

  const selfRow = self.rows[0];
  return [
    {
      profile: "self",
      name: selfRow.display_name ? String(selfRow.display_name) : "Self",
      email: selfRow.email ? String(selfRow.email) : null,
      is_self: true,
      oura_connected: Boolean(selfRow.oura_connected)
    },
    ...shared.rows.map((row) => ({
      profile: String(row.alias),
      name: String(row.alias),
      email: row.email ? String(row.email) : null,
      is_self: false,
      oura_connected: Boolean(row.oura_connected)
    }))
  ];
}

export async function resolveFamilyProfile(ownerUserId: string, profile?: string | null) {
  const selector = profile?.trim();
  if (!selector || selector.toLowerCase() === "self") {
    return { userId: ownerUserId, profile: "self", isSelf: true };
  }

  const result = await db.query(
    `SELECT profile_user_id, alias
       FROM family_access
      WHERE owner_user_id=$1 AND status='active' AND lower(alias)=lower($2)`,
    [ownerUserId, selector]
  );
  if (result.rowCount === 0) throw new Error(`Unknown or unauthorized family profile: ${selector}`);
  if ((result.rowCount ?? 0) > 1) throw new Error(`Ambiguous family profile name: ${selector}`);
  return {
    userId: String(result.rows[0].profile_user_id),
    profile: String(result.rows[0].alias),
    isSelf: false
  };
}

export async function shareProfileWithOwner(profileUserId: string, ownerEmailInput: string, aliasInput: string) {
  const ownerEmail = ownerEmailInput.trim().toLowerCase();
  const alias = cleanAlias(aliasInput);
  if (!ownerEmail) throw new Error("Owner email is required");

  const owner = await db.query(`SELECT id FROM users WHERE lower(email)=lower($1) LIMIT 1`, [ownerEmail]);
  if (!owner.rowCount) throw new Error("Family owner account not found");
  const ownerUserId = String(owner.rows[0].id);
  if (ownerUserId === profileUserId) throw new Error("You cannot share your profile with yourself");

  const duplicateAlias = await db.query(
    `SELECT 1 FROM family_access
      WHERE owner_user_id=$1 AND status='active' AND lower(alias)=lower($2) AND profile_user_id<>$3
      LIMIT 1`,
    [ownerUserId, alias, profileUserId]
  );
  if (duplicateAlias.rowCount) throw new Error("That profile name is already used in this family");

  await db.query(
    `INSERT INTO family_access(owner_user_id, profile_user_id, alias, status)
     VALUES ($1, $2, $3, 'active')
     ON CONFLICT (owner_user_id, profile_user_id) DO UPDATE SET
       alias=EXCLUDED.alias,
       status='active',
       updated_at=now()`,
    [ownerUserId, profileUserId, alias]
  );

  return { ownerUserId, alias };
}

export async function renameFamilyProfile(ownerUserId: string, currentAlias: string, newAliasInput: string) {
  const newAlias = cleanAlias(newAliasInput);
  const conflict = await db.query(
    `SELECT 1 FROM family_access
      WHERE owner_user_id=$1 AND status='active' AND lower(alias)=lower($2)
      LIMIT 1`,
    [ownerUserId, newAlias]
  );
  if (conflict.rowCount && currentAlias.toLowerCase() !== newAlias.toLowerCase()) {
    throw new Error("That profile name is already used in this family");
  }
  const result = await db.query(
    `UPDATE family_access SET alias=$3, updated_at=now()
      WHERE owner_user_id=$1 AND status='active' AND lower(alias)=lower($2)
      RETURNING alias`,
    [ownerUserId, currentAlias, newAlias]
  );
  if (!result.rowCount) throw new Error("Family profile not found");
  return String(result.rows[0].alias);
}

export async function revokeFamilyAccess(actorUserId: string, ownerUserId: string, profileUserId: string) {
  if (actorUserId !== ownerUserId && actorUserId !== profileUserId) throw new Error("Not authorized");
  const result = await db.query(
    `UPDATE family_access SET status='revoked', updated_at=now()
      WHERE owner_user_id=$1 AND profile_user_id=$2 AND status='active'`,
    [ownerUserId, profileUserId]
  );
  return (result.rowCount ?? 0) > 0;
}
