"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Button } from "@/components/ui/Button";
import { StepAesthetics } from "./StepAesthetics";
import { StepBrands, MIN_BRANDS_REQUIRED } from "./StepBrands";
import { StepPreferences } from "./StepPreferences";
import { StepComplete } from "./StepComplete";
import { saveOnboarding } from "@/app/actions/onboarding";

const FORM_STEPS = 3;

export interface OnboardingDefaults {
  aesthetics: string[];
  brands: string[];
  size: string | null;
  budgetMax: number | null;
  categories: string[];
  colors: string[];
}

function toggle(list: string[], value: string): string[] {
  return list.includes(value)
    ? list.filter((item) => item !== value)
    : [...list, value];
}

const slideVariants = {
  enter: (dir: number) => ({ x: dir > 0 ? 40 : -40, opacity: 0 }),
  center: { x: 0, opacity: 1 },
  exit: (dir: number) => ({ x: dir > 0 ? -40 : 40, opacity: 0 }),
};

export function OnboardingFlow({
  defaults,
}: {
  defaults: OnboardingDefaults;
}) {
  const [step, setStep] = useState(0);
  const [direction, setDirection] = useState(1);

  const [aesthetics, setAesthetics] = useState<string[]>(defaults.aesthetics);
  const [brands, setBrands] = useState<string[]>(defaults.brands);
  const [size, setSize] = useState<string | null>(defaults.size);
  const [budgetMax, setBudgetMax] = useState<number | null>(
    defaults.budgetMax,
  );
  const [categories, setCategories] = useState<string[]>(defaults.categories);
  const [colors, setColors] = useState<string[]>(defaults.colors);

  const [saveStatus, setSaveStatus] = useState<
    "saving" | "success" | "error"
  >("saving");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const hasSavedRef = useRef(false);

  const isComplete = step === FORM_STEPS;
  // P0 first-60-seconds fix (item 9) — "user must choose at least five
  // brands." Only actually gates the Brands step (step 1) itself; other
  // steps are unaffected regardless of how many brands are selected.
  const isBrandsStepBelowMinimum = step === 1 && brands.length < MIN_BRANDS_REQUIRED;

  function goNext() {
    setDirection(1);
    setStep((current) => Math.min(current + 1, FORM_STEPS));
  }

  function goBack() {
    setDirection(-1);
    setStep((current) => Math.max(current - 1, 0));
  }

  async function handleSave() {
    setSaveStatus("saving");
    setErrorMessage(null);

    const result = await saveOnboarding({
      aesthetics,
      brands,
      size,
      budgetMax,
      categories,
      colors,
    });

    if (result?.error) {
      hasSavedRef.current = false;
      setSaveStatus("error");
      setErrorMessage(result.error);
    } else {
      setSaveStatus("success");
    }
  }

  useEffect(() => {
    if (isComplete && !hasSavedRef.current) {
      hasSavedRef.current = true;
      handleSave();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isComplete]);

  return (
    <div className="min-h-[calc(100vh-137px)] px-6 py-12">
      {!isComplete && (
        <div className="mx-auto mb-10 max-w-md">
          <div className="h-1.5 w-full overflow-hidden rounded-pill bg-parchment-deep">
            <motion.div
              className="h-full rounded-pill bg-oxblood"
              animate={{ width: `${((step + 1) / FORM_STEPS) * 100}%` }}
              transition={{ type: "spring", stiffness: 200, damping: 30 }}
            />
          </div>
        </div>
      )}

      <AnimatePresence mode="wait">
        <motion.div
          key={step}
          custom={direction}
          variants={slideVariants}
          initial="enter"
          animate="center"
          exit="exit"
          transition={{ duration: 0.25, ease: "easeInOut" }}
        >
          {step === 0 && (
            <StepAesthetics
              selected={aesthetics}
              onToggle={(id) => setAesthetics((current) => toggle(current, id))}
            />
          )}
          {step === 1 && (
            <StepBrands
              selected={brands}
              onToggle={(id) => setBrands((current) => toggle(current, id))}
            />
          )}
          {step === 2 && (
            <StepPreferences
              size={size}
              onSizeChange={setSize}
              budgetMax={budgetMax}
              onBudgetChange={setBudgetMax}
              categories={categories}
              onToggleCategory={(category) =>
                setCategories((current) => toggle(current, category))
              }
              colors={colors}
              onToggleColor={(color) =>
                setColors((current) => toggle(current, color))
              }
            />
          )}
          {step === 3 && (
            <StepComplete
              status={saveStatus}
              errorMessage={errorMessage}
              onRetry={handleSave}
            />
          )}
        </motion.div>
      </AnimatePresence>

      {!isComplete && (
        <div className="mx-auto mt-10 flex max-w-2xl flex-col items-center gap-2">
          <div className="flex w-full items-center justify-between">
            <Button
              variant="ghost"
              onClick={goBack}
              className={step === 0 ? "invisible" : ""}
            >
              Back
            </Button>
            <Button
              onClick={goNext}
              disabled={isBrandsStepBelowMinimum}
            >
              {step === FORM_STEPS - 1 ? "Finish" : "Continue"}
            </Button>
          </div>
          {isBrandsStepBelowMinimum && (
            <p className="text-xs text-ink-soft">
              Choose at least {MIN_BRANDS_REQUIRED} brands to continue.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
