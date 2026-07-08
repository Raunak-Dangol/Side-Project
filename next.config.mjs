/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // eSewa/Khalti images may be remote; allow picsum for placeholder product images.
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "picsum.photos" },
      { protocol: "https", hostname: "images.unsplash.com" },
    ],
  },
};

export default nextConfig;
