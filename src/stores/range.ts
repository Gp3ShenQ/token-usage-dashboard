import { defineStore } from "pinia";

function dayOffset(days: number) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toLocaleDateString("en-CA", { timeZone: "Asia/Taipei" });
}

export const useRangeStore = defineStore("range", {
  state: () => ({
    from: dayOffset(6),
    to: dayOffset(0),
    preset: "7d" as "today" | "7d" | "30d" | "custom",
  }),
  actions: {
    setPreset(preset: "today" | "7d" | "30d") {
      this.preset = preset;
      if (preset === "today") {
        this.from = dayOffset(0);
        this.to = dayOffset(0);
      } else if (preset === "7d") {
        this.from = dayOffset(6);
        this.to = dayOffset(0);
      } else {
        this.from = dayOffset(29);
        this.to = dayOffset(0);
      }
    },
    setCustom(from: string, to: string) {
      this.preset = "custom";
      this.from = from;
      this.to = to;
    },
  },
});
