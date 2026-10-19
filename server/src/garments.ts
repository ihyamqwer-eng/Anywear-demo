export interface Garment {
  id: string;
  name: string;
  image: string;
  prompt: string;
  enabled: boolean;
}

export const garments: Garment[] = [
  {
    id: 'studio-white-tee',
    name: 'Studio White',
    image: '/garments/studio-white-tee.png',
    prompt: 'Substitute the current top with a plain white crew-neck T-shirt. Preserve the person, pose, and background.',
    enabled: true,
  },
  {
    id: 'cobalt-stripe-tee',
    name: 'Cobalt Stripe',
    image: '/garments/cobalt-stripe-tee.png',
    prompt: 'Substitute the current top with a cobalt-blue T-shirt with pale blue horizontal stripes. Preserve the person, pose, and background.',
    enabled: true,
  },
  {
    id: 'coral-hoodie',
    name: 'Coral Hoodie',
    image: '/garments/coral-hoodie.png',
    prompt: 'Substitute the current top with a coral pullover hoodie with a hood and front pocket. Preserve the person, pose, and background.',
    enabled: true,
  },
  {
    id: 'forest-crewneck',
    name: 'Forest Crewneck',
    image: '/garments/forest-crewneck.png',
    prompt: 'Substitute the current top with a dark forest-green crew-neck sweatshirt with a small pale-green square chest emblem. Preserve the person, pose, and background.',
    enabled: true,
  },
  {
    id: 'ink-graphic-tee',
    name: 'Ink Graphic',
    image: '/garments/ink-graphic-tee.png',
    prompt: 'Substitute the current top with a charcoal-black T-shirt with a coral star graphic centered on the chest. Preserve the person, pose, and background.',
    enabled: true,
  },
];
