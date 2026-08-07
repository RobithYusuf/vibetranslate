// App Configuration - Single source of truth

// Check if running in development mode
const isDev = typeof window !== 'undefined' && 
  (window.location.hostname === 'localhost' || window.location.port === '1420');

export const APP_CONFIG = {
  // App info
  APP_NAME: 'VibeTranslate',
  APP_VERSION: '1.0.33',
  
  // URLs
  DOMAIN: 'vibetranslate.id',
  
  // API URL - always use production (server deployed on api.vibetranslate.id)
  get API_URL() {
    return 'https://api.vibetranslate.id';
  },
  
  // Landing page
  get WEB_URL() {
    return isDev 
      ? 'http://localhost:3000' 
      : 'https://vibetranslate.id';
  },
  
  // Pricing page
  get PRICING_URL() {
    return `${this.WEB_URL}/#pricing`;
  },
  
  // Support email
  SUPPORT_EMAIL: 'vibetranslateid@gmail.com',
  
  // Cache settings
  STATUS_CACHE_DURATION: 1000 * 60 * 60, // 1 hour
  FOCUS_CHECK_COOLDOWN: 1000 * 60 * 5, // 5 minutes
  
  // License
  LICENSE_PREFIX: 'VIBE',
  MAX_DEVICES: 3,
};

export default APP_CONFIG;
