import { loadFont as montserrat } from '@remotion/google-fonts/Montserrat';
import { loadFont as inter } from '@remotion/google-fonts/Inter';
import { loadFont as poppins } from '@remotion/google-fonts/Poppins';
import { loadFont as bebas } from '@remotion/google-fonts/BebasNeue';
import { loadFont as roboto } from '@remotion/google-fonts/Roboto';
import { loadFont as openSans } from '@remotion/google-fonts/OpenSans';
import { loadFont as lato } from '@remotion/google-fonts/Lato';
import { loadFont as oswald } from '@remotion/google-fonts/Oswald';
import { loadFont as playfair } from '@remotion/google-fonts/PlayfairDisplay';

// Fonts offered for subtitles, titles and title cards (Montserrat = default font).
const opts = { subsets: ['latin', 'latin-ext'] as ('latin' | 'latin-ext')[] };
export const FONTS: Record<string, string> = {
  Montserrat: montserrat('normal', { weights: ['700', '800', '900'], ...opts }).fontFamily,
  Inter: inter('normal', { weights: ['500', '700', '800'], ...opts }).fontFamily,
  Poppins: poppins('normal', { weights: ['600', '700', '800'], ...opts }).fontFamily,
  'Bebas Neue': bebas('normal', { weights: ['400'], ...opts }).fontFamily,
  Roboto: roboto('normal', { weights: ['500', '700', '900'], ...opts }).fontFamily,
  'Open Sans': openSans('normal', { weights: ['600', '700', '800'], ...opts }).fontFamily,
  Lato: lato('normal', { weights: ['700', '900'], ...opts }).fontFamily,
  Oswald: oswald('normal', { weights: ['500', '600', '700'], ...opts }).fontFamily,
  'Playfair Display': playfair('normal', { weights: ['700', '800', '900'], ...opts }).fontFamily,
};

export const fontFamily = (name: string) => FONTS[name] || FONTS.Montserrat;
