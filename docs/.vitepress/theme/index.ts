import { h } from 'vue';
import DefaultTheme from 'vitepress/theme';
import HeroCode from './HeroCode.vue';
import './style.css';

export default {
  extends: DefaultTheme,
  Layout: () =>
    h(DefaultTheme.Layout, null, {
      'home-hero-info-before': () => h('span', { class: 'kr-pill' }, 'Alpha · on npm'),
      'home-hero-image': () => h(HeroCode),
    }),
};
