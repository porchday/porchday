import {ApiError,type Content,type EncryptedEnvelope} from './api';
import {WALLPAPERS} from './wallpaper';

type Initialization = {
  read: () => Promise<{envelope?: EncryptedEnvelope | null}>;
  seal: (profile: Content) => Promise<EncryptedEnvelope>;
  save: (envelope: EncryptedEnvelope) => Promise<unknown>;
};

/** A starter choice is encrypted and saved once, never derived again on render.
 * The existing server revision guard makes revision-one creation race-safe.
 * Any saved envelope, including an older profile without wallpaper, wins.
 */
export async function initializeEmptyProfile(io: Initialization): Promise<boolean> {
  if ((await io.read()).envelope) return false;
  const random = crypto.getRandomValues(new Uint32Array(1))[0];
  const envelope = await io.seal({
    wallpaper: WALLPAPERS[random % WALLPAPERS.length].id,
    theme: 'apricot',
    font: 'serif',
    sectionOrder: 'about-first',
  });
  try {
    await io.save(envelope);
    return true;
  } catch (error) {
    if (error instanceof ApiError && error.code === 'REVISION_CHANGED') {
      // Another device or a deliberate profile edit won. Never overwrite it.
      if ((await io.read()).envelope) return false;
    }
    throw error;
  }
}
