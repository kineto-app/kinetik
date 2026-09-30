/** Explicit preview examples, not natural-language understanding. */
export const demoTasks = [
  {
    title: 'Create a note',
    description: 'A little space for your ideas',
    prompt: 'Create a welcome note for me.',
    filename: 'Welcome.txt',
    content:
      'My notes\n\nA place to collect ideas, reminders, and things I want to come back to.\n',
    reply: 'Your note is ready.',
  },
  {
    title: 'Make a packing list',
    description: 'Get ready for a weekend away',
    prompt: 'Create a packing list for a weekend away.',
    filename: 'Weekend packing list.txt',
    content:
      'Weekend packing list\n\nClothing\n- Two outfits\n- Sleepwear and underwear\n- Comfortable shoes\n- A light jacket\n\nEssentials\n- Toiletries and any medication\n- Phone and charger\n- Wallet, ID, and tickets\n- Reusable water bottle\n\nBefore leaving\n- Check the weather\n- Confirm your booking and travel times\n',
    reply: 'Here’s your weekend packing list.',
  },
] as const;
