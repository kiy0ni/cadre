import { loadFont as montserrat } from '@remotion/google-fonts/Montserrat';
import { loadFont as inter } from '@remotion/google-fonts/Inter';
import { loadFont as poppins } from '@remotion/google-fonts/Poppins';
import { loadFont as bebas } from '@remotion/google-fonts/BebasNeue';

// Montserrat = la seule police du style KiyOni ; les autres servent aux packs « sobres ».
const opts = { subsets: ['latin', 'latin-ext'] as ('latin' | 'latin-ext')[] };
export const FONTS: Record<string, string> = {
  Montserrat: montserrat('normal', { weights: ['700', '800', '900'], ...opts }).fontFamily,
  Inter: inter('normal', { weights: ['500', '700', '800'], ...opts }).fontFamily,
  Poppins: poppins('normal', { weights: ['600', '700', '800'], ...opts }).fontFamily,
  'Bebas Neue': bebas('normal', { weights: ['400'], ...opts }).fontFamily,
};

export const fontFamily = (name: string) => FONTS[name] || FONTS.Montserrat;
