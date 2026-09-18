import { use } from "echarts/core";
import { BarChart, GaugeChart, PieChart } from "echarts/charts";
import { CanvasRenderer } from "echarts/renderers";
import { GridComponent, LegendComponent, TitleComponent, TooltipComponent } from "echarts/components";

use([BarChart, GaugeChart, PieChart, CanvasRenderer, GridComponent, LegendComponent, TitleComponent, TooltipComponent]);
